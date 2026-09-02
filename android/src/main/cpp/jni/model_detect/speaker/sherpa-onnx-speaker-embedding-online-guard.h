#ifndef SHERPA_ONNX_SPEAKER_EMBEDDING_ONLINE_GUARD_H
#define SHERPA_ONNX_SPEAKER_EMBEDDING_ONLINE_GUARD_H

#include "sherpa-onnx-model-detect.h"

#include <string>

namespace sherpaonnx::speaker_embedding::online_guard {

struct OnlineGuardResult {
    bool passed = true;
    std::string error;
};

bool LooksLikeAbsolutePath(const std::string& path);

/** ORT metadata preflight (not streaming; naming mirrors enhancement guard). */
OnlineGuardResult RunOnlineCompatibilityGuard(
    SpeakerEmbeddingModelKind kind,
    const std::string& modelPath
);

}  // namespace sherpaonnx::speaker_embedding::online_guard

#endif  // SHERPA_ONNX_SPEAKER_EMBEDDING_ONLINE_GUARD_H
