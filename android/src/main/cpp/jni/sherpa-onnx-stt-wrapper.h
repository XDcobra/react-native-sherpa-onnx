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
    std::string error;
    std::vector<DetectedModel> detectedModels;  // List of detected models with type and path
};

/**
 * Wrapper class for sherpa-onnx OfflineRecognizer (STT).
 * This provides a C++ interface that can be easily called from JNI.
 */
class SttWrapper {
public:
    SttWrapper();
    ~SttWrapper();

    /**
     * Initialize sherpa-onnx STT with model directory.
     * @param modelDir Path to the model directory
     * @param preferInt8 Optional: true = prefer int8 models, false = prefer regular models, nullopt = try int8 first (default)
     * @param modelType Optional: explicit model type ("transducer", "paraformer", "nemo_ctc"), nullopt = auto-detect (default)
     * @return SttInitializeResult with success status and list of detected usable models
     */
    SttInitializeResult initialize(
        const std::string& modelDir,
        const std::optional<bool>& preferInt8 = std::nullopt,
        const std::optional<std::string>& modelType = std::nullopt
    );

    /**
     * Transcribe an audio file.
     * @param filePath Path to the audio file (WAV 16kHz mono 16-bit PCM)
     * @return Transcribed text
     */
    std::string transcribeFile(const std::string& filePath);

    /**
     * Check if the recognizer is initialized.
     * @return true if initialized, false otherwise
     */
    bool isInitialized() const;

    /**
     * Release resources.
     */
    void release();

private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};

} // namespace sherpaonnx

#endif // SHERPA_ONNX_STT_WRAPPER_H
