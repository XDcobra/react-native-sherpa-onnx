#ifndef SHERPA_ONNX_TTS_WRAPPER_H
#define SHERPA_ONNX_TTS_WRAPPER_H

#include "sherpa-onnx-common.h"
#include "sherpa-onnx-model-detect.h"
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace sherpaonnx {

/** Voice cloning / zero-shot options for Zipvoice and Pocket (matches JS referenceAudio + referenceSampleRate + optional fields). */
struct VoiceCloneOptions {
    std::vector<float> reference_audio;
    int32_t reference_sample_rate = 0;
    std::string reference_text;
    int32_t num_steps = 5;
    float silence_scale = 0.2f;
    std::unordered_map<std::string, std::string> extra;
};

/**
 * Result of TTS initialization.
 */
struct TtsInitializeResult {
    bool success;
    std::vector<DetectedModel> detectedModels;  // List of detected models with type and path
    /** When success is false, optional error message (e.g. from DetectTtsModel or OfflineTts::Create). */
    std::string error;
};

/**
 * Wrapper class for sherpa-onnx OfflineTts.
 */
class TtsWrapper {
public:
    TtsWrapper();
    ~TtsWrapper();

    TtsInitializeResult initialize(
        const std::string& modelDir,
        const std::string& modelType = "auto",
        int32_t numThreads = 2,
        bool debug = false,
        const std::optional<float>& noiseScale = std::nullopt,
        const std::optional<float>& noiseScaleW = std::nullopt,
        const std::optional<float>& lengthScale = std::nullopt,
        const std::optional<std::string>& ruleFsts = std::nullopt,
        const std::optional<std::string>& ruleFars = std::nullopt,
        const std::optional<int32_t>& maxNumSentences = std::nullopt,
        const std::optional<float>& silenceScale = std::nullopt,
        const std::optional<std::string>& provider = std::nullopt
    );

    struct AudioResult {
        std::vector<float> samples;  // Audio samples in range [-1.0, 1.0]
        int32_t sampleRate;          // Sample rate in Hz
    };

    using TtsStreamCallback = std::function<int32_t(
        const float *samples,
        int32_t numSamples,
        float progress
    )>;

    AudioResult generate(
        const std::string& text,
        int32_t sid = 0,
        float speed = 1.0f
    );

    /**
     * When cloning is set (non-empty reference_audio and reference_sample_rate > 0), calls
     * OfflineTts::Generate(text, GenerationConfig). Otherwise same as generate(text, sid, speed).
     */
    AudioResult generate(
        const std::string& text,
        int32_t sid,
        float speed,
        const std::optional<VoiceCloneOptions>& cloning
    );

    bool generateStream(
        const std::string& text,
        int32_t sid,
        float speed,
        const TtsStreamCallback& callback
    );

    /** Pocket: streaming with reference audio. Zipvoice + cloning is not supported (match Android). */
    bool generateStream(
        const std::string& text,
        int32_t sid,
        float speed,
        const TtsStreamCallback& callback,
        const std::optional<VoiceCloneOptions>& cloning
    );

    static bool saveToWavFile(
        const std::vector<float>& samples,
        int32_t sampleRate,
        const std::string& filePath
    );

    int32_t getSampleRate() const;

    int32_t getNumSpeakers() const;

    bool isInitialized() const;

    /** Model kind from last successful initialize() (for voice-cloning validation). */
    TtsModelKind getModelKind() const;

    void release();

private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};

} // namespace sherpaonnx

#endif // SHERPA_ONNX_TTS_WRAPPER_H
