#pragma once

#include <functional>
#include <memory>
#include <sstream>
#include <utility>

#include "codec/CodecArbiter.h"
#include "codec/CodecCatalog.h"
#include "codec/CodecEvents.h"
#include "codec/CodecLog.h"
#include "codec/CodecPolicy.h"
#include "codec/CodecTypes.h"

namespace sherpa_onnx {
namespace codec {

template <class Backend>
struct SelectResult {
  Status status;
  std::unique_ptr<Backend> backend;
  Lease lease;
  Decision decision;
  bool ok() const { return status.ok && static_cast<bool>(backend); }
};

inline Reason ReasonFromOpen(const Status& st) {
  if (st.errorCode == "pool-full") return Reason::PoolFull;
  if (st.errorCode == "reclaimed" || st.errorMessage.find("1101") != std::string::npos) {
    return Reason::Reclaimed;
  }
  if (st.errorCode == "invalid-session") return Reason::InvalidSession;
  if (st.errorCode == kErrVideoSwDecoderDisabled ||
      st.errorCode == kErrVideoSwEncoderDisabled) {
    return Reason::Disabled;
  }
  return Reason::ConfigureFailed;
}

template <class Backend>
SelectResult<Backend> Select(
    const Request& req, CodecArbiter& arb,
    const std::function<Result<std::unique_ptr<Backend>>(const Provider&)>&
        open) {
  SelectResult<Backend> out;
  const Plan plan = MakePlan(req, CodecCatalog::Instance());
  out.decision.attempts = plan.skipped;

  auto finishEmpty = [&](Reason reason, Tier tier) {
    out.status = Status::Fail(ErrorCodeFor(req, reason, tier), ReasonName(reason));
    std::ostringstream att;
    for (size_t i = 0; i < out.decision.attempts.size(); ++i) {
      if (i) att << ",";
      att << out.decision.attempts[i].provider << ":"
          << ReasonName(out.decision.attempts[i].reason);
    }
    CODEC_LOGI("codec.fail owner=%s code=%s attempts=%s", req.ownerKey.c_str(),
               out.status.errorCode.c_str(), att.str().c_str());
  };

  if (plan.steps.empty()) {
    Reason r = Reason::NotPresent;
    Tier t = req.policy == Policy::Software ? Tier::Software : Tier::Hardware;
    if (!plan.skipped.empty()) {
      r = plan.skipped.back().reason;
      t = plan.skipped.back().tier;
    }
    finishEmpty(r, t);
    return out;
  }

  bool sawHwFail = false;
  std::string fromCode;
  Reason fromReason = Reason::None;

  for (const auto& step : plan.steps) {
    const Provider* p = step.provider;
    if (!p) continue;
    CODEC_LOGI("codec.try owner=%s provider=%s resource=%s",
               req.ownerKey.c_str(), p->name.c_str(), ResourceName(step.resource));
    auto lease = arb.TryAcquire(step.resource, req.ownerKey);
    if (!lease.ok()) {
      Attempt a;
      a.provider = p->name;
      a.tier = p->tier;
      a.origin = p->origin;
      a.reason = Reason::PoolFull;
      a.code = ErrorCodeFor(req, Reason::PoolFull, p->tier);
      out.decision.attempts.push_back(a);
      if (p->tier == Tier::Hardware) {
        sawHwFail = true;
        fromCode = a.code;
        fromReason = Reason::PoolFull;
      }
      continue;
    }
    auto opened = open(*p);
    if (!opened.ok() || !opened.value) {
      const Reason rr = ReasonFromOpen(opened.status);
      Attempt a;
      a.provider = p->name;
      a.tier = p->tier;
      a.origin = p->origin;
      a.reason = rr;
      a.code = opened.status.errorCode.empty()
                   ? ErrorCodeFor(req, rr, p->tier)
                   : opened.status.errorCode;
      out.decision.attempts.push_back(a);
      if (p->tier == Tier::Hardware) {
        sawHwFail = true;
        fromCode = a.code;
        fromReason = rr;
      }
      continue;
    }
    out.backend = std::move(opened.value);
    out.lease = std::move(lease.value);
    out.decision.tier = p->tier;
    out.decision.origin = p->origin;
    out.decision.provider = p->name;
    if (sawHwFail && p->tier == Tier::Software) {
      out.decision.fellBack = true;
      out.decision.fallbackReason = fromReason;
      out.decision.fallbackCode = fromCode;
      EmitFallback(req.ownerKey, req.use == Use::Export && req.media == Media::Image
                                     ? Use::Cpu
                                     : req.use,
                   out.decision);
    }
    CODEC_LOGI(
        "codec.select owner=%s provider=%s tier=%s origin=%s fellBack=%d from=%s/%s",
        req.ownerKey.c_str(), p->name.c_str(), TierName(p->tier),
        OriginName(p->origin), out.decision.fellBack ? 1 : 0,
        out.decision.fallbackCode.c_str(),
        ReasonName(out.decision.fallbackReason));
    return out;
  }

  Reason r = Reason::NotPresent;
  Tier t = req.policy == Policy::Software ? Tier::Software : Tier::Hardware;
  if (!out.decision.attempts.empty()) {
    r = out.decision.attempts.back().reason;
    t = out.decision.attempts.back().tier;
  }
  finishEmpty(r, t);
  return out;
}

}  // namespace codec
}  // namespace sherpa_onnx
