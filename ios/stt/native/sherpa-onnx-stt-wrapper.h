#ifndef SHERPA_ONNX_IOS_STT_WRAPPER_H
#define SHERPA_ONNX_IOS_STT_WRAPPER_H

#include "sherpa-onnx-common.h"
#include "sherpa-onnx-model-detect.h"
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
    /** When success is false, optional error message (e.g. HOTWORDS_NOT_SUPPORTED). */
    std::string error;
    /** Loaded model type (e.g. "whisper", "transducer") for JS modelType in init result. */
    std::string modelType;
    /** Decoding method actually applied (e.g. "greedy_search", "modified_beam_search"). Set when success is true. */
    std::string decodingMethod;
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

/** Model-specific options: Whisper (matches JS `modelOptions.whisper` / Android). */
struct SttWhisperOptions {
    std::optional<std::string> language;
    std::optional<std::string> task;
    std::optional<int32_t> tail_paddings;
    std::optional<bool> enable_token_timestamps;
    std::optional<bool> enable_segment_timestamps;
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

/** Model-specific options: Qwen3 ASR (sherpa-onnx OfflineQwen3ASRModelConfig). */
struct SttQwen3AsrOptions {
    std::optional<int32_t> max_total_len;
    std::optional<int32_t> max_new_tokens;
    std::optional<float> temperature;
    std::optional<float> top_p;
    std::optional<int32_t> seed;
    /** Comma-separated phrases; applied per stream via SetOption (not hotwords_file). Optional. */
    std::optional<std::string> hotwords;
};

/** Model-specific options: Cohere Transcribe (OfflineCohereTranscribeModelConfig). */
struct SttCohereTranscribeOptions {
    std::optional<std::string> language;
    std::optional<bool> use_punct;
    std::optional<bool> use_itn;
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
        const SttFunAsrNanoOptions* funasrNanoOpts = nullptr,
        const SttQwen3AsrOptions* qwen3AsrOpts = nullptr,
        const SttCohereTranscribeOptions* cohereTranscribeOpts = nullptr
    );

    /** Skip auto-detection; use explicit resolved model file paths. */
    SttInitializeResult initializeCustom(
        const std::string& modelType,
        const SttModelPaths& paths,
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
        const SttFunAsrNanoOptions* funasrNanoOpts = nullptr,
        const SttQwen3AsrOptions* qwen3AsrOpts = nullptr,
        const SttCohereTranscribeOptions* cohereTranscribeOpts = nullptr
    );

    SttRecognitionResult transcribeFile(const std::string& filePath);

    SttRecognitionResult transcribeSamples(const std::vector<float>& samples, int32_t sampleRate);

    /**
     * Feeds `samples` into an offline stream in batches of `chunkSize` before decoding.
     * When `samples.size() <= chunkSize`, equivalent to `transcribeSamples`.
     * Whisper uses an internal 30-second window; see docs/stt-offline.md.
     */
    SttRecognitionResult transcribeSamplesChunked(const std::vector<float>& samples, int32_t sampleRate, int32_t chunkSize);

    void setConfig(const SttRuntimeConfigOptions& options);

    bool isInitialized() const;

    void release();

private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};

} // namespace sherpaonnx

#endif // SHERPA_ONNX_IOS_STT_WRAPPER_H
