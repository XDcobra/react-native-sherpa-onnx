#ifndef SHERPA_ONNX_MODEL_DETECT_UNIFIED_H
#define SHERPA_ONNX_MODEL_DETECT_UNIFIED_H

#include "sherpa-onnx-common.h"
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace sherpaonnx {

struct UnifiedModelDetectInput {
    std::optional<std::string> model_dir;
    std::optional<std::string> asset_name;
};

struct UnifiedModelDetectResult {
    bool matched = false;
    std::string category;
    bool success = false;
    std::string modelType;
    std::vector<std::string> languages;
    std::string quantization;
    std::string sizeTier;
    bool isStreaming = false;
    bool isHardwareSpecificUnsupported = false;
    std::vector<DetectedModel> detectedModels;
    std::vector<std::string> detectionSources;
    std::map<std::string, std::string> paths;
    std::string error;
};

/**
 * Run TTS→STT→VAD→Punctuation→Enhancement→Alignment detectors; first hit wins.
 * Pass at least one of model_dir or asset_name (via UnifiedModelDetectInput).
 */
UnifiedModelDetectResult DetectModel(
    const std::optional<std::string>& model_dir,
    const std::optional<std::string>& asset_name);

std::vector<UnifiedModelDetectResult> DetectModelsBatch(
    const std::vector<UnifiedModelDetectInput>& inputs);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_MODEL_DETECT_UNIFIED_H
