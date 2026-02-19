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
 * Full recognition result (aligned with JS SttRecognitionResult).
 */
struct SttRecognitionResult {
    std::string text;
    std::vector<std::string> tokens;
    std::vector<float> timestamps;
    std::string lang;
    std::string emotion;
    std::string event;
    std::vector<float> durations;
};

/**
 * Runtime config options for setConfig (only mutable fields).
 */
struct SttRuntimeConfigOptions {
    std::optional<std::string> decoding_method;
    std::optional<int32_t> max_active_paths;
    std::optional<std::string> hotwords_file;
    std::optional<float> hotwords_score;
    std::optional<float> blank_penalty;
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
        const std::optional<std::string>& modelType = std::nullopt,
        bool debug = false,
        const std::optional<std::string>& hotwordsFile = std::nullopt,
        const std::optional<float>& hotwordsScore = std::nullopt
    );

    SttRecognitionResult transcribeFile(const std::string& filePath);

    SttRecognitionResult transcribeSamples(const std::vector<float>& samples, int32_t sampleRate);

    void setConfig(const SttRuntimeConfigOptions& options);

    bool isInitialized() const;

    void release();

private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};

} // namespace sherpaonnx

#endif // SHERPA_ONNX_STT_WRAPPER_H
