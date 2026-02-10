#ifndef SHERPA_ONNX_TTS_WRAPPER_H
#define SHERPA_ONNX_TTS_WRAPPER_H

#include "sherpa-onnx-common.h"
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace sherpaonnx {

/**
 * Result of TTS initialization.
 */
struct TtsInitializeResult {
    bool success;
    std::vector<DetectedModel> detectedModels;  // List of detected models with type and path
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
        const std::optional<float>& lengthScale = std::nullopt
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

    bool generateStream(
        const std::string& text,
        int32_t sid,
        float speed,
        const TtsStreamCallback& callback
    );

    static bool saveToWavFile(
        const std::vector<float>& samples,
        int32_t sampleRate,
        const std::string& filePath
    );

    int32_t getSampleRate() const;

    int32_t getNumSpeakers() const;

    bool isInitialized() const;

    void release();

private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};

} // namespace sherpaonnx

#endif // SHERPA_ONNX_TTS_WRAPPER_H
