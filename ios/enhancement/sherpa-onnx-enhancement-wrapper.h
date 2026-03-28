#ifndef SHERPA_ONNX_ENHANCEMENT_WRAPPER_H
#define SHERPA_ONNX_ENHANCEMENT_WRAPPER_H

#include "sherpa-onnx-common.h"
#include "sherpa-onnx-model-detect.h"
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace sherpaonnx {

struct EnhancementInitializeResult {
    bool success = false;
    std::vector<DetectedModel> detectedModels;
    std::string error;
    std::string modelType;
    int32_t sampleRate = 0;
    int32_t frameShiftInSamples = 0;
};

struct EnhancedAudioResult {
    std::vector<float> samples;
    int32_t sampleRate = 0;
};

class EnhancementWrapper {
public:
    EnhancementWrapper();
    ~EnhancementWrapper();

    EnhancementInitializeResult initialize(
        const std::string& modelDir,
        const std::string& modelType = "auto",
        int32_t numThreads = 1,
        const std::optional<std::string>& provider = std::nullopt,
        bool debug = false
    );

    EnhancedAudioResult runSamples(const std::vector<float>& samples, int32_t sampleRate);

    int32_t getSampleRate() const;

    bool isInitialized() const;

    void release();

private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};

class OnlineEnhancementWrapper {
public:
    OnlineEnhancementWrapper();
    ~OnlineEnhancementWrapper();

    EnhancementInitializeResult initialize(
        const std::string& modelDir,
        const std::string& modelType = "auto",
        int32_t numThreads = 1,
        const std::optional<std::string>& provider = std::nullopt,
        bool debug = false
    );

    EnhancedAudioResult runSamples(const std::vector<float>& samples, int32_t sampleRate);
    EnhancedAudioResult flush();
    void reset();

    int32_t getSampleRate() const;
    int32_t getFrameShiftInSamples() const;

    bool isInitialized() const;

    void release();

private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};

} // namespace sherpaonnx

#endif // SHERPA_ONNX_ENHANCEMENT_WRAPPER_H
