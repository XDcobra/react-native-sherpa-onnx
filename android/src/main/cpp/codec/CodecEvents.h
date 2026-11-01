#pragma once

#include <functional>
#include <string>

#include "codec/CodecTypes.h"

namespace sherpa_onnx {
namespace codec {

using EventSink = std::function<void(const std::string& json)>;

void SetEventSink(EventSink sink);
void ResetEventsForTest();

void EmitSlotFreed(ResourceClass resource, int max, int inUse);
void EmitFallback(const std::string& owner, Use use, const Decision& decision);

std::string DecisionJson(const Decision& d);
std::string SlotFreedJson(ResourceClass resource, int max, int inUse);
std::string FallbackJson(const std::string& owner, Use use,
                         const Decision& d);

}  // namespace codec
}  // namespace sherpa_onnx
