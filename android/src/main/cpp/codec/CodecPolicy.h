#pragma once

#include <optional>
#include <string>

#include "codec/CodecCatalog.h"
#include "codec/CodecTypes.h"

namespace sherpa_onnx {
namespace codec {

Policy ResolvePolicy(std::optional<Policy> operation,
                     std::optional<Policy> buffer,
                     std::optional<Policy> global,
                     Policy sdkDefault = Policy::PreferHardware);

Plan MakePlan(const Request& req, const CodecCatalog& catalog);

double ScaledFps1080(const ProviderCaps& caps, const StreamCaps& stream);

}  // namespace codec
}  // namespace sherpa_onnx
