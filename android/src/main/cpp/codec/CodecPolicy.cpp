#include "codec/CodecPolicy.h"

#include <algorithm>
#include <sstream>

#include "codec/CodecCaps.h"
#include "codec/CodecLog.h"

namespace sherpa_onnx {
namespace codec {
namespace {

bool IsHw(const Provider& p) { return p.tier == Tier::Hardware; }
bool IsSw(const Provider& p) { return p.tier == Tier::Software; }

bool Prefer(const Provider* a, const Provider* b) {
  if (a->origin != b->origin) {
    return a->origin == Origin::Platform;
  }
  if (a->rank != b->rank) return a->rank < b->rank;
  return a->name < b->name;
}

Attempt SkipOf(const Provider& p, Reason reason, const Request& req) {
  Attempt a;
  a.provider = p.name;
  a.tier = p.tier;
  a.origin = p.origin;
  a.reason = reason;
  a.code = ErrorCodeFor(req, reason, p.tier);
  return a;
}

bool TooSlowForDisplay(const Provider& p, const Request& req) {
  if (req.use != Use::Display || p.tier != Tier::Software) return false;
  const double scaled = ScaledFps1080(p.caps, req.stream);
  if (scaled <= 0 || req.stream.fps <= 0) {
    CODEC_LOGI("codec.plan sw-display allowed (unknown fps) provider=%s",
               p.name.c_str());
    return false;
  }
  return scaled < kSwRealtimeMargin * req.stream.fps;
}

void AppendTier(std::vector<const Provider*> candidates, bool wantHw,
                const Request& req, Plan* plan) {
  std::vector<const Provider*> picked;
  for (const Provider* p : candidates) {
    if (!p) continue;
    if (wantHw && !IsHw(*p)) continue;
    if (!wantHw && !IsSw(*p)) continue;
    if (!p->available) {
      plan->skipped.push_back(
          SkipOf(*p,
                 p->unavailableReason == Reason::None ? Reason::NotPresent
                                                      : p->unavailableReason,
                 req));
      continue;
    }
    std::string why;
    if (!StreamFits(p->caps, req.stream, &why)) {
      (void)why;
      plan->skipped.push_back(SkipOf(*p, Reason::UnsupportedStream, req));
      continue;
    }
    if (TooSlowForDisplay(*p, req)) {
      plan->skipped.push_back(SkipOf(*p, Reason::SwTooSlow, req));
      continue;
    }
    picked.push_back(p);
  }
  std::sort(picked.begin(), picked.end(), Prefer);
  for (const Provider* p : picked) {
    PlanStep step;
    step.provider = p;
    step.resource = ResourceFor(req, p->tier);
    plan->steps.push_back(step);
  }
}

}  // namespace

double ScaledFps1080(const ProviderCaps& caps, const StreamCaps& stream) {
  if (caps.measuredFps1080Low <= 0) return 0;
  if (stream.width <= 0 || stream.height <= 0) return caps.measuredFps1080Low;
  const double area =
      static_cast<double>(stream.width) * static_cast<double>(stream.height);
  const double ref =
      static_cast<double>(kRefWidth1080) * static_cast<double>(kRefHeight1080);
  return caps.measuredFps1080Low * (ref / area);
}

Policy ResolvePolicy(std::optional<Policy> operation,
                     std::optional<Policy> buffer,
                     std::optional<Policy> global, Policy sdkDefault) {
  if (operation) return *operation;
  if (buffer) return *buffer;
  if (global) return *global;
  return sdkDefault;
}

Plan MakePlan(const Request& req, const CodecCatalog& catalog) {
  Plan plan;
  auto found = catalog.Find(req.media, req.dir, req.stream.codec);
  const bool wantHw =
      req.policy == Policy::Hardware || req.policy == Policy::PreferHardware;
  const bool wantSw =
      req.policy == Policy::Software || req.policy == Policy::PreferHardware;
  if (wantHw) AppendTier(found, true, req, &plan);
  if (wantSw) AppendTier(found, false, req, &plan);

  std::ostringstream steps;
  for (size_t i = 0; i < plan.steps.size(); ++i) {
    if (i) steps << ",";
    steps << plan.steps[i].provider->name;
  }
  std::ostringstream skipped;
  for (size_t i = 0; i < plan.skipped.size(); ++i) {
    if (i) skipped << ",";
    skipped << plan.skipped[i].provider << ":" << ReasonName(plan.skipped[i].reason);
  }
  const bool swNone = wantSw && std::none_of(
      plan.steps.begin(), plan.steps.end(),
      [](const PlanStep& s) { return s.provider && IsSw(*s.provider); });
  CODEC_LOGI(
      "codec.plan owner=%s use=%s policy=%s steps=%s skipped=%s%s",
      req.ownerKey.c_str(), UseName(req.use), PolicyName(req.policy),
      steps.str().c_str(), skipped.str().c_str(),
      swNone && wantSw ? " sw=none" : "");
  return plan;
}

}  // namespace codec
}  // namespace sherpa_onnx
