#include "sherpa-onnx-separation-wrapper.h"

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-separation.h"

#include <cstdio>
#include <cstring>
#include <exception>
#include <new>
#include <optional>
#include <string>

#include "sherpa-onnx/c-api/c-api.h"

#ifdef __ANDROID__
#include <android/log.h>
#define SEPARATION_LOG_TAG "SherpaOnnxSeparation"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, SEPARATION_LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, SEPARATION_LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, SEPARATION_LOG_TAG, __VA_ARGS__)
#elif defined(__APPLE__)
// Prefer fprintf over os_log with printf "%s" — os_log does not accept printf
// style %s and can crash during initializeSeparation on iOS.
#define LOGI(...)                                                          \
  do {                                                                     \
    std::fprintf(stderr, "[SherpaOnnxSeparation] ");                       \
    std::fprintf(stderr, __VA_ARGS__);                                     \
    std::fprintf(stderr, "\n");                                            \
  } while (0)
#define LOGW(...) LOGI(__VA_ARGS__)
#define LOGE(...) LOGI(__VA_ARGS__)
#else
#define LOGI(...) ((void)0)
#define LOGW(...) ((void)0)
#define LOGE(...) ((void)0)
#endif

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
    // Always set an explicit provider. Leaving nullptr relies on C-API defaults
    // but makes debugging harder across Android/iOS.
    bundle.provider =
        (provider.has_value() && !provider->empty()) ? *provider : "cpu";
    bundle.config.model.provider = bundle.provider.c_str();

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
    LOGI(
        "initialize: modelDir=%s modelType=%s threads=%d debug=%d provider=%s "
        "vocals=%s accompaniment=%s uvr=%s",
        modelDir.c_str(),
        result.modelType.c_str(),
        numThreads,
        debug ? 1 : 0,
        engineConfig.provider.c_str(),
        engineConfig.vocals.c_str(),
        engineConfig.accompaniment.c_str(),
        engineConfig.uvrModel.c_str()
    );
    try {
        pImpl->separation =
            SherpaOnnxCreateOfflineSourceSeparation(&engineConfig.config);
    } catch (const std::exception& e) {
        result.error = std::string(
                           "Failed to create offline source separation engine: "
                       ) +
                       e.what();
        LOGE("initialize threw: %s", result.error.c_str());
        return result;
    } catch (...) {
        result.error =
            "Failed to create offline source separation engine (unknown "
            "exception)";
        LOGE("initialize threw unknown exception");
        return result;
    }
    if (pImpl->separation == nullptr) {
        result.error =
            "Failed to create offline source separation engine (Create "
            "returned null — check model paths exist and are readable)";
        LOGE(
            "initialize failed: %s vocals=%s accompaniment=%s uvr=%s",
            result.error.c_str(),
            engineConfig.vocals.c_str(),
            engineConfig.accompaniment.c_str(),
            engineConfig.uvrModel.c_str()
        );
        return result;
    }

    pImpl->initialized = true;
    result.success = true;
    result.sampleRate = SherpaOnnxOfflineSourceSeparationGetOutputSampleRate(pImpl->separation);
    result.numStems = SherpaOnnxOfflineSourceSeparationGetNumberOfStems(pImpl->separation);
    LOGI(
        "initialize ok: sampleRate=%d numStems=%d",
        result.sampleRate,
        result.numStems
    );
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
    LOGI(
        "initializeCustom: modelType=%s threads=%d debug=%d provider=%s "
        "vocals=%s accompaniment=%s uvr=%s",
        result.modelType.c_str(),
        numThreads,
        debug ? 1 : 0,
        engineConfig.provider.c_str(),
        engineConfig.vocals.c_str(),
        engineConfig.accompaniment.c_str(),
        engineConfig.uvrModel.c_str()
    );
    try {
        pImpl->separation =
            SherpaOnnxCreateOfflineSourceSeparation(&engineConfig.config);
    } catch (const std::exception& e) {
        result.error = std::string(
                           "Failed to create offline source separation engine: "
                       ) +
                       e.what();
        LOGE("initializeCustom threw: %s", result.error.c_str());
        return result;
    } catch (...) {
        result.error =
            "Failed to create offline source separation engine (unknown "
            "exception)";
        LOGE("initializeCustom threw unknown exception");
        return result;
    }
    if (pImpl->separation == nullptr) {
        result.error =
            "Failed to create offline source separation engine (Create "
            "returned null — check model paths exist and are readable)";
        LOGE("initializeCustom failed: %s", result.error.c_str());
        return result;
    }

    pImpl->initialized = true;
    result.success = true;
    result.sampleRate = SherpaOnnxOfflineSourceSeparationGetOutputSampleRate(pImpl->separation);
    result.numStems = SherpaOnnxOfflineSourceSeparationGetNumberOfStems(pImpl->separation);
    LOGI(
        "initializeCustom ok: sampleRate=%d numStems=%d",
        result.sampleRate,
        result.numStems
    );
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

    try {
        // Spleeter's native path always reads channel 0 and 1; mono input alone
        // triggers SHERPA_ONNX_EXIT inside sherpa-onnx. UVR tolerates missing ch1.
        const int32_t numSamples = static_cast<int32_t>(monoSamples.size());
        std::vector<float> stereoRight = monoSamples;
        const float* channels[] = {monoSamples.data(), stereoRight.data()};
        constexpr int32_t kNumChannels = 2;
        LOGI(
            "processMonoSamples: numSamples=%d sampleRate=%d channels=%d (mono upmixed to stereo)",
            numSamples,
            sampleRate,
            kNumChannels
        );
        const SherpaOnnxSourceSeparationOutput* output =
            SherpaOnnxOfflineSourceSeparationProcess(
                pImpl->separation, channels, kNumChannels, numSamples, sampleRate
            );
        if (output == nullptr) {
            result.error = "Source separation processing failed";
            LOGE("processMonoSamples failed: native Process returned null");
            return result;
        }

        result = ToSeparationProcessResult(output);
        SherpaOnnxDestroySourceSeparationOutput(output);
        if (result.success) {
            LOGI(
                "processMonoSamples ok: stems=%zu",
                result.stems.size()
            );
        } else {
            LOGE("processMonoSamples failed: %s", result.error.c_str());
        }
        return result;
    } catch (const std::bad_alloc&) {
        // Parity with STT/alignment: surface catchable C++ OOM as OFFLINE_OOM.
        // Does not cover OS low-memory kills or hard native aborts.
        result.success = false;
        result.stems.clear();
        result.error =
            "OFFLINE_OOM: Not enough memory for offline source separation";
        LOGE("processMonoSamples failed: %s", result.error.c_str());
        return result;
    }
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
        LOGI("release: destroying separation engine");
        SherpaOnnxDestroyOfflineSourceSeparation(pImpl->separation);
        pImpl->separation = nullptr;
    }
    pImpl->initialized = false;
}

}  // namespace sherpaonnx
