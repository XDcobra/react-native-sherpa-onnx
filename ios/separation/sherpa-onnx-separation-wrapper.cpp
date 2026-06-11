#include "sherpa-onnx-separation-wrapper.h"

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-separation.h"

#include <optional>

#include "sherpa-onnx/c-api/cxx-api.h"

namespace sherpaonnx {
namespace {

std::string SeparationKindToString(SeparationModelKind kind) {
    switch (kind) {
        case SeparationModelKind::kSpleeter:
            return "spleeter";
        case SeparationModelKind::kUvr:
            return "uvr";
        default:
            return "unknown";
    }
}

SeparationModelKind ParseSeparationModelTypeFromString(const std::string& modelType) {
    if (modelType == "spleeter") return SeparationModelKind::kSpleeter;
    if (modelType == "uvr") return SeparationModelKind::kUvr;
    return SeparationModelKind::kUnknown;
}

sherpa_onnx::cxx::OfflineSourceSeparationModelConfig BuildModelConfigFromPaths(
    SeparationModelKind kind,
    const SeparationModelPaths& paths,
    int32_t numThreads,
    const std::optional<std::string>& provider,
    bool debug
) {
    sherpa_onnx::cxx::OfflineSourceSeparationModelConfig cfg;
    cfg.num_threads = numThreads;
    cfg.debug = debug;
    if (provider.has_value() && !provider->empty()) {
        cfg.provider = *provider;
    }
    switch (kind) {
        case SeparationModelKind::kSpleeter:
            cfg.spleeter.vocals = paths.vocals;
            cfg.spleeter.accompaniment = paths.accompaniment;
            break;
        case SeparationModelKind::kUvr:
            cfg.uvr.model = paths.model;
            break;
        default:
            break;
    }
    return cfg;
}

sherpa_onnx::cxx::OfflineSourceSeparationModelConfig BuildModelConfig(
    const SeparationDetectResult& detect,
    int32_t numThreads,
    const std::optional<std::string>& provider,
    bool debug
) {
    return BuildModelConfigFromPaths(
        detect.selectedKind, detect.paths, numThreads, provider, debug
    );
}

std::vector<float> DownmixStemToMono(
    const sherpa_onnx::cxx::SourceSeparationStem& stem
) {
    if (stem.samples.empty()) {
        return {};
    }
    if (stem.samples.size() == 1) {
        return stem.samples[0];
    }
    const size_t n = stem.samples[0].size();
    for (size_t c = 1; c < stem.samples.size(); ++c) {
        if (stem.samples[c].size() != n) {
            return {};
        }
    }
    std::vector<float> mono(n);
    const float invChannels = 1.0f / static_cast<float>(stem.samples.size());
    for (size_t i = 0; i < n; ++i) {
        float sum = 0.0f;
        for (const auto& channel : stem.samples) {
            sum += channel[i];
        }
        mono[i] = sum * invChannels;
    }
    return mono;
}

SeparationProcessResult ToSeparationProcessResult(
    const sherpa_onnx::cxx::SourceSeparationOutput& output
) {
    SeparationProcessResult result;
    result.stems.reserve(output.stems.size());
    for (const auto& stem : output.stems) {
        SeparationStemAudio audio;
        audio.sampleRate = output.sample_rate;
        audio.samples = DownmixStemToMono(stem);
        if (audio.samples.empty() && !stem.samples.empty()) {
            result.success = false;
            result.error = "Stem channel length mismatch during mono downmix";
            result.stems.clear();
            return result;
        }
        result.stems.push_back(std::move(audio));
    }
    result.success = !result.stems.empty();
    if (!result.success && result.error.empty()) {
        result.error = "Source separation produced no stems";
    }
    return result;
}

}  // namespace

class SeparationWrapper::Impl {
public:
    bool initialized = false;
    std::optional<sherpa_onnx::cxx::OfflineSourceSeparation> separation;
};

SeparationWrapper::SeparationWrapper() : pImpl(std::make_unique<Impl>()) {}

SeparationWrapper::~SeparationWrapper() { release(); }

SeparationInitializeResult SeparationWrapper::initialize(
    const std::string& modelDir,
    const std::string& modelType,
    int32_t numThreads,
    const std::optional<std::string>& provider,
    bool debug
) {
    SeparationInitializeResult result;
    if (pImpl->initialized) {
        release();
    }
    if (modelDir.empty()) {
        result.error = "Separation model directory is empty";
        return result;
    }

    auto detect = DetectSeparationModel(
        std::optional<std::string>(modelDir),
        std::nullopt,
        modelType
    );
    result.detectedModels = detect.detectedModels;
    result.modelType = SeparationKindToString(detect.selectedKind);
    if (!detect.ok) {
        result.error = detect.error;
        return result;
    }

    auto validation = ValidateSeparationPaths(
        detect.selectedKind, detect.paths, modelDir
    );
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }

    sherpa_onnx::cxx::OfflineSourceSeparationConfig config;
    config.model = BuildModelConfig(detect, numThreads, provider, debug);
    pImpl->separation = sherpa_onnx::cxx::OfflineSourceSeparation::Create(config);
    if (!pImpl->separation.has_value() || !pImpl->separation->Get()) {
        result.error = "Failed to create offline source separation engine";
        pImpl->separation.reset();
        return result;
    }

    pImpl->initialized = true;
    result.success = true;
    result.sampleRate = pImpl->separation->GetOutputSampleRate();
    result.numStems = pImpl->separation->GetNumberOfStems();
    return result;
}

SeparationInitializeResult SeparationWrapper::initializeCustom(
    const std::string& modelType,
    const SeparationModelPaths& paths,
    int32_t numThreads,
    const std::optional<std::string>& provider,
    bool debug
) {
    SeparationInitializeResult result;
    if (pImpl->initialized) {
        release();
    }

    const SeparationModelKind selectedKind =
        ParseSeparationModelTypeFromString(modelType);
    if (selectedKind == SeparationModelKind::kUnknown) {
        result.error = "Unsupported custom separation model type";
        return result;
    }

    auto validation = ValidateSeparationPaths(selectedKind, paths, "custom");
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }

    result.modelType = SeparationKindToString(selectedKind);
    result.detectedModels.push_back({result.modelType, "custom"});

    sherpa_onnx::cxx::OfflineSourceSeparationConfig config;
    config.model = BuildModelConfigFromPaths(
        selectedKind, paths, numThreads, provider, debug
    );
    pImpl->separation = sherpa_onnx::cxx::OfflineSourceSeparation::Create(config);
    if (!pImpl->separation.has_value() || !pImpl->separation->Get()) {
        result.error = "Failed to create offline source separation engine";
        pImpl->separation.reset();
        return result;
    }

    pImpl->initialized = true;
    result.success = true;
    result.sampleRate = pImpl->separation->GetOutputSampleRate();
    result.numStems = pImpl->separation->GetNumberOfStems();
    return result;
}

SeparationProcessResult SeparationWrapper::processMonoSamples(
    const std::vector<float>& monoSamples,
    int32_t sampleRate
) {
    SeparationProcessResult result;
    if (!pImpl->initialized || !pImpl->separation.has_value()) {
        result.error = "Separation engine is not initialized";
        return result;
    }
    if (monoSamples.empty()) {
        result.error = "Input audio is empty";
        return result;
    }
    if (sampleRate <= 0) {
        result.error = "Invalid input sample rate";
        return result;
    }

    const float* channels[] = {monoSamples.data()};
    const int32_t numSamples = static_cast<int32_t>(monoSamples.size());
    auto output = pImpl->separation->Process(channels, 1, numSamples, sampleRate);
    return ToSeparationProcessResult(output);
}

int32_t SeparationWrapper::getSampleRate() const {
    if (!pImpl->initialized || !pImpl->separation.has_value()) return 0;
    return pImpl->separation->GetOutputSampleRate();
}

int32_t SeparationWrapper::getNumStems() const {
    if (!pImpl->initialized || !pImpl->separation.has_value()) return 0;
    return pImpl->separation->GetNumberOfStems();
}

bool SeparationWrapper::isInitialized() const { return pImpl->initialized; }

void SeparationWrapper::release() {
    if (pImpl->separation.has_value()) {
        pImpl->separation.reset();
    }
    pImpl->initialized = false;
}

}  // namespace sherpaonnx
