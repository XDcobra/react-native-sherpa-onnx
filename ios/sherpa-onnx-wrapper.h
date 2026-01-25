#ifndef SHERPA_ONNX_WRAPPER_H
#define SHERPA_ONNX_WRAPPER_H

#include <string>
#include <memory>
#include <optional>

namespace sherpaonnx {

/**
 * Wrapper class for sherpa-onnx OfflineRecognizer.
 * This provides a C++ interface that can be easily called from iOS Objective-C++.
 */
class SherpaOnnxWrapper {
public:
    SherpaOnnxWrapper();
    ~SherpaOnnxWrapper();

    /**
     * Initialize sherpa-onnx with model directory.
     * @param modelDir Path to the model directory
     * @param preferInt8 Optional: true = prefer int8 models, false = prefer regular models, nullopt = try int8 first (default)
     * @param modelType Optional: explicit model type ("transducer", "paraformer", "nemo_ctc"), nullopt = auto-detect (default)
     * @return true if successful, false otherwise
     */
    bool initialize(
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

#endif // SHERPA_ONNX_WRAPPER_H
