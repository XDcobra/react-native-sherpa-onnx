#include "sherpa-onnx-separation-wrapper.h"

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-separation.h"

#include <cstring>
#include <optional>

#include "sherpa-onnx/c-api/c-api.h"

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

struct SeparationEngineConfig {
    SherpaOnnxOfflineSourceSeparationConfig config{};
    std::string vocals;
    std::string accompaniment;
    std::string uvrModel;
    std::string provider;
};

SeparationEngineConfig BuildEngineConfig(
    SeparationModelKind kind,
    const SeparationModelPaths& paths,
    int32_t numThreads,
    const std::optional<std::string>& provider,
    bool debug
) {
    SeparationEngineConfig bundle;
    std::memset(&bundle.config, 0, sizeof(bundle.config));

    bundle.config.model.num_threads = numThreads;
    bundle.config.model.debug = debug ? 1 : 0;
    if (provider.has_value() && !provider->empty()) {
        bundle.provider = *provider;
        bundle.config.model.provider = bundle.provider.c_str();
    }

    switch (kind) {
        case SeparationModelKind::kSpleeter:
            bundle.vocals = paths.vocals;
            bundle.accompaniment = paths.accompaniment;
            bundle.config.model.spleeter.vocals = bundle.vocals.c_str();
            bundle.config.model.spleeter.accompaniment = bundle.accompaniment.c_str();
            break;
        case SeparationModelKind::kUvr:
            bundle.uvrModel = paths.model;
            bundle.config.model.uvr.model = bundle.uvrModel.c_str();
            break;
        default:
            break;
    }
    return bundle;
}

SeparationEngineConfig BuildEngineConfig(
    const SeparationDetectResult& detect,
    int32_t numThreads,
    const std::optional<std::string>& provider,
    bool debug
) {
    return BuildEngineConfig(
        detect.selectedKind, detect.paths, numThreads, provider, debug
    );
}

std::vector<float> DownmixStemToMono(const SherpaOnnxSourceSeparationStem& stem) {
    if (stem.num_channels <= 0 || stem.samples == nullptr || stem.n <= 0) {
        return {};
    }
    if (stem.num_channels == 1) {
        return {stem.samples[0], stem.samples[0] + stem.n};
    }
    const int32_t n = stem.n;
    for (int32_t c = 1; c < stem.num_channels; ++c) {
        if (stem.samples[c] == nullptr) {
            return {};
        }
    }
    std::vector<float> mono(static_cast<size_t>(n));
    const float invChannels = 1.0f / static_cast<float>(stem.num_channels);
    for (int32_t i = 0; i < n; ++i) {
        float sum = 0.0f;
        for (int32_t c = 0; c < stem.num_channels; ++c) {
            sum += stem.samples[c][i];
        }
        mono[static_cast<size_t>(i)] = sum * invChannels;
    }
    return mono;
}

SeparationProcessResult ToSeparationProcessResult(
    const SherpaOnnxSourceSeparationOutput* output
) {
    SeparationProcessResult result;
    if (output == nullptr || output->stems == nullptr || output->num_stems <= 0) {
        result.error = "Source separation produced no stems";
        return result;
    }

    result.stems.reserve(static_cast<size_t>(output->num_stems));
    for (int32_t s = 0; s < output->num_stems; ++s) {
        SeparationStemAudio audio;
        audio.sampleRate = output->sample_rate;
        audio.samples = DownmixStemToMono(output->stems[s]);
        if (audio.samples.empty()) {
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
    const SherpaOnnxOfflineSourceSeparation* separation = nullptr;
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

    auto engineConfig = BuildEngineConfig(detect, numThreads, provider, debug);
    pImpl->separation = SherpaOnnxCreateOfflineSourceSeparation(&engineConfig.config);
    if (pImpl->separation == nullptr) {
        result.error = "Failed to create offline source separation engine";
        return result;
    }

    pImpl->initialized = true;
    result.success = true;
    result.sampleRate = SherpaOnnxOfflineSourceSeparationGetOutputSampleRate(pImpl->separation);
    result.numStems = SherpaOnnxOfflineSourceSeparationGetNumberOfStems(pImpl->separation);
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

    auto engineConfig = BuildEngineConfig(
        selectedKind, paths, numThreads, provider, debug
    );
    pImpl->separation = SherpaOnnxCreateOfflineSourceSeparation(&engineConfig.config);
    if (pImpl->separation == nullptr) {
        result.error = "Failed to create offline source separation engine";
        return result;
    }

    pImpl->initialized = true;
    result.success = true;
    result.sampleRate = SherpaOnnxOfflineSourceSeparationGetOutputSampleRate(pImpl->separation);
    result.numStems = SherpaOnnxOfflineSourceSeparationGetNumberOfStems(pImpl->separation);
    return result;
}

SeparationProcessResult SeparationWrapper::processMonoSamples(
    const std::vector<float>& monoSamples,
    int32_t sampleRate
) {
    SeparationProcessResult result;
    if (!pImpl->initialized || pImpl->separation == nullptr) {
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
    const SherpaOnnxSourceSeparationOutput* output =
        SherpaOnnxOfflineSourceSeparationProcess(
            pImpl->separation, channels, 1, numSamples, sampleRate
        );
    if (output == nullptr) {
        result.error = "Source separation processing failed";
        return result;
    }

    result = ToSeparationProcessResult(output);
    SherpaOnnxDestroySourceSeparationOutput(output);
    return result;
}

int32_t SeparationWrapper::getSampleRate() const {
    if (!pImpl->initialized || pImpl->separation == nullptr) return 0;
    return SherpaOnnxOfflineSourceSeparationGetOutputSampleRate(pImpl->separation);
}

int32_t SeparationWrapper::getNumStems() const {
    if (!pImpl->initialized || pImpl->separation == nullptr) return 0;
    return SherpaOnnxOfflineSourceSeparationGetNumberOfStems(pImpl->separation);
}

bool SeparationWrapper::isInitialized() const { return pImpl->initialized; }

void SeparationWrapper::release() {
    if (pImpl->separation != nullptr) {
        SherpaOnnxDestroyOfflineSourceSeparation(pImpl->separation);
        pImpl->separation = nullptr;
    }
    pImpl->initialized = false;
}

}  // namespace sherpaonnx
