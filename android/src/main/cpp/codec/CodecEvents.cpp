#include "codec/CodecEvents.h"

#include <mutex>
#include <sstream>
#include <unordered_set>

namespace sherpa_onnx {
namespace codec {
namespace {

std::mutex gMu;
EventSink gSink;
std::unordered_set<std::string> gFallbackKeys;

std::string AttemptsJson(const std::vector<Attempt>& attempts) {
  std::ostringstream os;
  os << "[";
  for (size_t i = 0; i < attempts.size(); ++i) {
    const auto& a = attempts[i];
    if (i) os << ",";
    os << "{\"provider\":\"" << EscapeJson(a.provider) << "\",\"tier\":\""
       << TierName(a.tier) << "\",\"origin\":\"" << OriginName(a.origin)
       << "\",\"reason\":\"" << ReasonName(a.reason) << "\"";
    if (!a.code.empty()) {
      os << ",\"code\":\"" << EscapeJson(a.code) << "\"";
    }
    os << "}";
  }
  os << "]";
  return os.str();
}

}  // namespace

void SetEventSink(EventSink sink) {
  std::lock_guard<std::mutex> lock(gMu);
  gSink = std::move(sink);
}

void ResetEventsForTest() {
  std::lock_guard<std::mutex> lock(gMu);
  gSink = {};
  gFallbackKeys.clear();
}

std::string DecisionJson(const Decision& d) {
  std::ostringstream os;
  os << "{\"tier\":\"" << TierName(d.tier) << "\",\"origin\":\""
     << OriginName(d.origin) << "\",\"provider\":\"" << EscapeJson(d.provider)
     << "\"";
  if (d.fellBack) {
    os << ",\"fallbackFrom\":{\"code\":\"" << EscapeJson(d.fallbackCode)
       << "\",\"reason\":\"" << ReasonName(d.fallbackReason) << "\"}";
  }
  if (!d.attempts.empty()) {
    os << ",\"attempts\":" << AttemptsJson(d.attempts);
  }
  os << "}";
  return os.str();
}

std::string SlotFreedJson(ResourceClass resource, int max, int inUse) {
  std::ostringstream os;
  os << "{\"type\":\"slotFreed\",\"resource\":\"" << ResourceJsName(resource)
     << "\",\"max\":" << max << ",\"inUse\":" << inUse << "}";
  return os.str();
}

std::string FallbackJson(const std::string& owner, Use use,
                         const Decision& d) {
  std::ostringstream os;
  os << "{\"type\":\"fallback\",\"owner\":\"" << EscapeJson(owner)
     << "\",\"use\":\"" << UseName(use) << "\",\"decision\":" << DecisionJson(d)
     << "}";
  return os.str();
}

void EmitSlotFreed(ResourceClass resource, int max, int inUse) {
  EventSink sink;
  {
    std::lock_guard<std::mutex> lock(gMu);
    sink = gSink;
  }
  if (sink) sink(SlotFreedJson(resource, max, inUse));
}

void EmitFallback(const std::string& owner, Use use, const Decision& decision) {
  const std::string key = owner + "|" + UseName(use) + "|" +
                          decision.provider + "|" +
                          ReasonName(decision.fallbackReason);
  EventSink sink;
  {
    std::lock_guard<std::mutex> lock(gMu);
    if (!gFallbackKeys.insert(key).second) {
      return;
    }
    sink = gSink;
  }
  if (sink) sink(FallbackJson(owner, use, decision));
}

}  // namespace codec
}  // namespace sherpa_onnx
