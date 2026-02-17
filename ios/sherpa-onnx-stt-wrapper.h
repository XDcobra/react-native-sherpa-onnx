#ifndef SHERPA_ONNX_STT_WRAPPER_H
#define SHERPA_ONNX_STT_WRAPPER_H

#include "sherpa-onnx-common.h"
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace sherpaonnx {

/**
 * Result of STT initialization.
 */
struct SttInitializeResult {
    bool success;
    std::vector<DetectedModel> detectedModels;  // List of detected models with type and path
};

/**
 * Wrapper class for sherpa-onnx OfflineRecognizer (STT).
 */
class SttWrapper {
public:
    SttWrapper();
    ~SttWrapper();

    SttInitializeResult initialize(
        const std::string& modelDir,
        const std::optional<bool>& preferInt8 = std::nullopt,
        const std::optional<std::string>& modelType = std::nullopt
        , bool debug = false
    );

    std::string transcribeFile(const std::string& filePath);

    bool isInitialized() const;

    void release();

private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};

} // namespace sherpaonnx

#endif // SHERPA_ONNX_STT_WRAPPER_H
