#include "codec/CodecRuntime.h"

#include <sstream>

#include "codec/CodecArbiter.h"
#include "codec/CodecCaps.h"
#include "codec/CodecCatalog.h"
#include "codec/CodecLog.h"
#include "codec/CodecPolicy.h"

namespace sherpa_onnx {
namespace codec {

CodecRuntime& CodecRuntime::Instance() {
  static CodecRuntime inst;
  return inst;
}

void CodecRuntime::Init(int64_t totalRamBytes) {
  std::lock_guard<std::mutex> lock(mu_);
  CodecCaps::Instance().Init(totalRamBytes);
  CodecCaps::Instance().ApplyInstanceHints(CodecCatalog::Instance().All());
  inited_ = true;
  CODEC_LOGI("codec.runtime init ram=%s default=preferHardware",
             RamClassName(CodecCaps::Instance().ramClass()));
}

Status CodecRuntime::Configure(
    const PolicyConfig& incoming,
    const std::vector<std::pair<ResourceClass, int>>& budgets,
    bool replaceAllPolicies) {
  std::lock_guard<std::mutex> lock(mu_);
  if (replaceAllPolicies) {
    policies_ = incoming;
  } else {
    policies_ = incoming;
  }
  for (const auto& b : budgets) {
    auto st = CodecCaps::Instance().SetOverride(b.first, b.second);
    if (!st.ok) return st;
  }
  return Status::Ok();
}

Status CodecRuntime::ConfigureFromNative(const char* videoDecode,
                                         const char* videoDisplay,
                                         const char* videoEncode,
                                         const char* imageDecode,
                                         const int budgets[6]) {
  auto apply = [](const char* s, Policy* dest) -> Status {
    if (s == nullptr || s[0] == '\0') return Status::Ok();
    auto p = ParsePolicy(s);
    if (!p) {
      return Status::Fail(kErrCodecInvalidArgument,
                          std::string("invalid policy: ") + s);
    }
    *dest = *p;
    return Status::Ok();
  };
  std::lock_guard<std::mutex> lock(mu_);
  Status st = apply(videoDecode, &policies_.videoDecode);
  if (!st.ok) return st;
  st = apply(videoDisplay, &policies_.videoDisplay);
  if (!st.ok) return st;
  st = apply(videoEncode, &policies_.videoEncode);
  if (!st.ok) return st;
  st = apply(imageDecode, &policies_.imageDecode);
  if (!st.ok) return st;
  if (budgets) {
    for (int i = 0; i < 6; ++i) {
      if (budgets[i] == 0) continue;
      st = CodecCaps::Instance().SetOverride(static_cast<ResourceClass>(i),
                                             budgets[i]);
      if (!st.ok) return st;
    }
  }
  return Status::Ok();
}

PolicyConfig CodecRuntime::policies() const {
  std::lock_guard<std::mutex> lock(mu_);
  return policies_;
}

Policy CodecRuntime::GlobalVideo(Use use) const {
  std::lock_guard<std::mutex> lock(mu_);
  if (use == Use::Display) return policies_.videoDisplay;
  if (use == Use::Export) return policies_.videoEncode;
  return policies_.videoDecode;
}

Policy CodecRuntime::GlobalImage() const {
  std::lock_guard<std::mutex> lock(mu_);
  return policies_.imageDecode;
}

Policy CodecRuntime::ResolveVideo(Use use, std::optional<Policy> operation,
                                  std::optional<Policy> buffer) const {
  return ResolvePolicy(operation, buffer, GlobalVideo(use));
}

Policy CodecRuntime::ResolveImage(std::optional<Policy> operation,
                                  std::optional<Policy> buffer) const {
  return ResolvePolicy(operation, buffer, GlobalImage());
}

std::string CodecRuntime::InfoJson() const {
  const auto pol = policies();
  const auto slots = CodecArbiter::Instance().Snapshot();
  const auto providers = CodecCatalog::Instance().All();
  std::ostringstream os;
  os << "{\"ramClass\":\"" << RamClassName(CodecCaps::Instance().ramClass())
     << "\",\"policies\":{\"decode\":\"" << PolicyName(pol.videoDecode)
     << "\",\"display\":\"" << PolicyName(pol.videoDisplay) << "\",\"encode\":\""
     << PolicyName(pol.videoEncode) << "\",\"imageDecode\":\""
     << PolicyName(pol.imageDecode) << "\"},\"slots\":[";
  for (size_t i = 0; i < slots.size(); ++i) {
    if (i) os << ",";
    os << "{\"resource\":\"" << ResourceJsName(slots[i].resource)
       << "\",\"max\":" << slots[i].max << ",\"inUse\":" << slots[i].inUse
       << ",\"source\":\"" << slots[i].source << "\"}";
  }
  os << "],\"providers\":[";
  for (size_t i = 0; i < providers.size(); ++i) {
    const auto& p = providers[i];
    if (i) os << ",";
    os << "{\"media\":\"" << MediaName(p.media) << "\",\"direction\":\""
       << DirectionName(p.dir) << "\",\"codec\":\"" << EscapeJson(p.codec)
       << "\",\"tier\":\"" << TierName(p.tier) << "\",\"origin\":\""
       << OriginName(p.origin) << "\",\"provider\":\"" << EscapeJson(p.name)
       << "\",\"available\":" << (p.available ? "true" : "false");
    if (!p.available) {
      os << ",\"reason\":\"" << ReasonName(p.unavailableReason) << "\"";
    }
    if (p.caps.maxW > 0) os << ",\"maxWidth\":" << p.caps.maxW;
    if (p.caps.maxH > 0) os << ",\"maxHeight\":" << p.caps.maxH;
    if (p.caps.maxInstancesHint > 0) {
      os << ",\"maxInstances\":" << p.caps.maxInstancesHint;
    }
    os << "}";
  }
  os << "]}";
  return os.str();
}

void CodecRuntime::ResetForTest() {
  std::lock_guard<std::mutex> lock(mu_);
  policies_ = {};
  inited_ = false;
  CodecCatalog::Instance().Clear();
  CodecCaps::Instance().ResetForTest();
  CodecArbiter::Instance().ResetForTest();
}

}  // namespace codec
}  // namespace sherpa_onnx
