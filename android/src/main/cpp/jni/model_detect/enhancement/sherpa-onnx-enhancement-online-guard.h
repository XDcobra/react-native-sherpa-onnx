#ifndef SHERPA_ONNX_ENHANCEMENT_ONLINE_GUARD_H
#define SHERPA_ONNX_ENHANCEMENT_ONLINE_GUARD_H

#include "sherpa-onnx-model-detect.h"

#include <string>

namespace sherpaonnx::enhancement::online_guard {

struct OnlineGuardResult {
    bool passed = true;
    std::string error;
};

bool IsStreamingCandidate(EnhancementModelKind kind);
bool LooksLikeAbsolutePath(const std::string& path);

OnlineGuardResult RunOnlineCompatibilityGuard(
    EnhancementModelKind kind,
    const std::string& modelPath
);

}  // namespace sherpaonnx::enhancement::online_guard

#endif  // SHERPA_ONNX_ENHANCEMENT_ONLINE_GUARD_H
