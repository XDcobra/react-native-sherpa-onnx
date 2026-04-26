#ifndef SHERPA_ONNX_PUNCTUATION_ONLINE_GUARD_H
#define SHERPA_ONNX_PUNCTUATION_ONLINE_GUARD_H

#include "sherpa-onnx-model-detect.h"

#include <string>

namespace sherpaonnx::punctuation::online_guard {

struct OnlineGuardResult {
    bool passed = true;
    std::string error;
};

bool IsStreamingCandidate(PunctuationModelKind kind);
bool LooksLikeAbsolutePath(const std::string& path);

/**
 * ORT preflight for sherpa `OnlineCNNBiLSTMModel` (online punctuation).
 * @param cnnBilstmOnnxPath Resolved path to the CNN-BiLSTM .onnx file
 */
OnlineGuardResult RunOnlineCompatibilityGuard(const std::string& cnnBilstmOnnxPath);

}  // namespace sherpaonnx::punctuation::online_guard

#endif  // SHERPA_ONNX_PUNCTUATION_ONLINE_GUARD_H
