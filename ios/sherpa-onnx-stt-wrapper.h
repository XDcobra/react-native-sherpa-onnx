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
    std::optional<std::string> rule_fsts;
    std::optional<std::string> rule_fars;
};

/** Model-specific options: Whisper (iOS: language, task, tail_paddings only). */
struct SttWhisperOptions {
    std::optional<std::string> language;
    std::optional<std::string> task;
    std::optional<int32_t> tail_paddings;
};

/** Model-specific options: SenseVoice. */
struct SttSenseVoiceOptions {
    std::optional<std::string> language;
    std::optional<bool> use_itn;
};

/** Model-specific options: Canary. */
struct SttCanaryOptions {
    std::optional<std::string> src_lang;
    std::optional<std::string> tgt_lang;
    std::optional<bool> use_pnc;
};

/** Model-specific options: FunASR Nano. */
struct SttFunAsrNanoOptions {
    std::optional<std::string> system_prompt;
    std::optional<std::string> user_prompt;
    std::optional<int32_t> max_new_tokens;
    std::optional<float> temperature;
    std::optional<float> top_p;
    std::optional<int32_t> seed;
    std::optional<std::string> language;
    std::optional<bool> itn;
    std::optional<std::string> hotwords;
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
        const std::optional<float>& hotwordsScore = std::nullopt,
        const std::optional<int32_t>& numThreads = std::nullopt,
        const std::optional<std::string>& provider = std::nullopt,
        const std::optional<std::string>& ruleFsts = std::nullopt,
        const std::optional<std::string>& ruleFars = std::nullopt,
        const std::optional<float>& dither = std::nullopt,
        const SttWhisperOptions* whisperOpts = nullptr,
        const SttSenseVoiceOptions* senseVoiceOpts = nullptr,
        const SttCanaryOptions* canaryOpts = nullptr,
        const SttFunAsrNanoOptions* funasrNanoOpts = nullptr
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
