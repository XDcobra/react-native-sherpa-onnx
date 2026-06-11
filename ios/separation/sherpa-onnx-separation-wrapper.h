#ifndef SHERPA_ONNX_SEPARATION_INFERENCE_WRAPPER_H
#define SHERPA_ONNX_SEPARATION_INFERENCE_WRAPPER_H

#include "sherpa-onnx-common.h"
#include "sherpa-onnx-model-detect.h"
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace sherpaonnx {

struct SeparationInitializeResult {
    bool success = false;
    std::vector<DetectedModel> detectedModels;
    std::string error;
    std::string modelType;
    int32_t sampleRate = 0;
    int32_t numStems = 0;
};

struct SeparationStemAudio {
    std::vector<float> samples;
    int32_t sampleRate = 0;
};

struct SeparationProcessResult {
    bool success = false;
    std::string error;
    std::vector<SeparationStemAudio> stems;
};

class SeparationWrapper {
public:
    SeparationWrapper();
    ~SeparationWrapper();

    SeparationInitializeResult initialize(
        const std::string& modelDir,
        const std::string& modelType = "auto",
        int32_t numThreads = 1,
        const std::optional<std::string>& provider = std::nullopt,
        bool debug = false
    );

    SeparationInitializeResult initializeCustom(
        const std::string& modelType,
        const SeparationModelPaths& paths,
        int32_t numThreads = 1,
        const std::optional<std::string>& provider = std::nullopt,
        bool debug = false
    );

    SeparationProcessResult processMonoSamples(
        const std::vector<float>& monoSamples,
        int32_t sampleRate
    );

    int32_t getSampleRate() const;
    int32_t getNumStems() const;
    bool isInitialized() const;
    void release();

private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_SEPARATION_INFERENCE_WRAPPER_H
