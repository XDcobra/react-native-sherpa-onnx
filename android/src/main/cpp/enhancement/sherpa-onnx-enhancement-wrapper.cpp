#include "sherpa-onnx-enhancement-wrapper.h"

#include "sherpa-onnx-enhancement-c-api-set-voice-sample.h"
#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-enhancement.h"

#include <cstdio>
#include <cstring>
#include <functional>
#include <optional>
#include <string>

#include "sherpa-onnx/c-api/c-api.h"

#ifdef __ANDROID__
#include <android/log.h>
#define ENH_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:init", __VA_ARGS__)
#define ENH_LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, "SherpaOnnx:init", __VA_ARGS__)
#elif defined(__APPLE__)
#define ENH_LOGI(...)                                                 \
  do {                                                                \
    std::fprintf(stderr, "[SherpaOnnx:init] ");                       \
    std::fprintf(stderr, __VA_ARGS__);                                \
    std::fprintf(stderr, "\n");                                       \
  } while (0)
#define ENH_LOGE(...) ENH_LOGI(__VA_ARGS__)
#else
#define ENH_LOGI(...) ((void)0)
#define ENH_LOGE(...) ((void)0)
#endif

namespace sherpaonnx {
namespace {

std::string EnhancementKindToString(EnhancementModelKind kind) {
    switch (kind) {
        case EnhancementModelKind::kGtcrn:
            return "gtcrn";
        case EnhancementModelKind::kDpdfNet:
            return "dpdfnet";
        case EnhancementModelKind::kVoxLock:
            return "voxlock";
        default:
            return "unknown";
    }
}

EnhancementModelKind ParseEnhancementModelTypeFromString(
    const std::string& modelType
) {
    if (modelType == "gtcrn") return EnhancementModelKind::kGtcrn;
    if (modelType == "dpdfnet") return EnhancementModelKind::kDpdfNet;
    if (modelType == "voxlock") return EnhancementModelKind::kVoxLock;
    return EnhancementModelKind::kUnknown;
}

std::string PathBaseName(const std::string& path) {
    const auto pos = path.find_last_of("/\\");
    return pos == std::string::npos ? path : path.substr(pos + 1);
}

struct DenoiserOwnedStrings {
    std::string model;
    std::string enrollModel;
    std::string chunkModel;
    std::string provider;
};

void FillModelConfig(
    SherpaOnnxOfflineSpeechDenoiserModelConfig& model,
    EnhancementModelKind kind,
    const EnhancementModelPaths& paths,
    int32_t numThreads,
    const std::optional<std::string>& provider,
    bool debug,
    DenoiserOwnedStrings& owned
) {
    std::memset(&model, 0, sizeof(model));
    model.num_threads = numThreads;
    model.debug = debug ? 1 : 0;
    owned.provider =
        (provider.has_value() && !provider->empty()) ? *provider : "cpu";
    model.provider = owned.provider.c_str();
    owned.model = paths.model;
    owned.enrollModel = paths.enrollModel;
    owned.chunkModel = paths.chunkModel;
    switch (kind) {
        case EnhancementModelKind::kGtcrn:
            model.gtcrn.model = owned.model.c_str();
            break;
        case EnhancementModelKind::kDpdfNet:
            model.dpdfnet.model = owned.model.c_str();
            break;
        case EnhancementModelKind::kVoxLock:
            model.voxlock.enroll_model = owned.enrollModel.c_str();
            model.voxlock.chunk_model = owned.chunkModel.c_str();
            ENH_LOGI(
                "enhancement Fill kind=voxlock enroll=%s chunk=%s voice_sample=empty",
                PathBaseName(owned.enrollModel).c_str(),
                PathBaseName(owned.chunkModel).c_str()
            );
            break;
        default:
            break;
    }
}

SetVoiceSampleResult CallSetVoiceSample(
    const char* streamKind,
    const std::string& modelKind,
    bool initialized,
    int32_t modelSampleRate,
    const std::function<int32_t(const float*, int32_t, int32_t)>& nativeCall,
    const std::vector<float>& samples,
    int32_t sampleRate
) {
    const int32_t n = static_cast<int32_t>(samples.size());
    auto log = [&](const char* ok, const char* reason, int32_t preparedLength) {
        ENH_LOGI(
            "%s setVoiceSample kind=%s n=%d inRate=%d preparedLength=%d ok=%s reason=%s",
            streamKind,
            modelKind.empty() ? "unknown" : modelKind.c_str(),
            n,
            sampleRate,
            preparedLength,
            ok,
            reason
        );
    };

    SetVoiceSampleResult result;
    if (!initialized) {
        log("false", "not-initialized", 0);
        result.error = "Enhancement instance is not initialized";
        return result;
    }
    if (n <= 0 || sampleRate <= 0) {
        log("false", "empty-pcm", 0);
        result.error = "Voice sample PCM is empty";
        return result;
    }
    if (modelKind != "voxlock") {
        log("false", "not-voxlock", 0);
        result.error = "setVoiceSample is only supported for VoxLock";
        return result;
    }

    const int32_t rc = nativeCall(samples.data(), n, sampleRate);
    if (rc != 0) {
        log("false", "too-short", 0);
        result.error =
            "VoxLock voice sample is too short after resample (need 3 seconds)";
        return result;
    }

    const int32_t preparedLength =
        modelSampleRate > 0 ? modelSampleRate * 3 : n;
    log("true", "stored", preparedLength);
    result.success = true;
    return result;
}

EnhancedAudioResult FromDenoisedAudio(const SherpaOnnxDenoisedAudio* audio) {
    EnhancedAudioResult out;
    if (audio == nullptr) {
        return out;
    }
    if (audio->samples != nullptr && audio->n > 0) {
        out.samples.assign(audio->samples, audio->samples + audio->n);
    }
    out.sampleRate = audio->sample_rate;
    SherpaOnnxDestroyDenoisedAudio(audio);
    return out;
}

}  // namespace

class EnhancementWrapper::Impl {
public:
    bool initialized = false;
    const SherpaOnnxOfflineSpeechDenoiser* denoiser = nullptr;
    DenoiserOwnedStrings owned;
    std::string modelKind;

    void destroy() {
        if (denoiser != nullptr) {
            SherpaOnnxDestroyOfflineSpeechDenoiser(denoiser);
            denoiser = nullptr;
        }
        initialized = false;
        owned = {};
        modelKind.clear();
    }
};

EnhancementWrapper::EnhancementWrapper() : pImpl(std::make_unique<Impl>()) {}

EnhancementWrapper::~EnhancementWrapper() { release(); }

EnhancementInitializeResult EnhancementWrapper::initialize(
    const std::string& modelDir,
    const std::string& modelType,
    int32_t numThreads,
    const std::optional<std::string>& provider,
    bool debug
) {
    EnhancementInitializeResult result;
    if (pImpl->initialized) {
        release();
    }
    if (modelDir.empty()) {
        result.error = "Enhancement model directory is empty";
        return result;
    }

    auto detect = DetectEnhancementModel(
        std::optional<std::string>(modelDir),
        std::nullopt,
        modelType
    );
    result.detectedModels = detect.detectedModels;
    result.modelType = EnhancementKindToString(detect.selectedKind);
    if (!detect.ok) {
        result.error = detect.error;
        return result;
    }
    SherpaOnnxOfflineSpeechDenoiserConfig config;
    std::memset(&config, 0, sizeof(config));
    FillModelConfig(
        config.model,
        detect.selectedKind,
        detect.paths,
        numThreads,
        provider,
        debug,
        pImpl->owned
    );
    const SherpaOnnxOfflineSpeechDenoiser* created =
        SherpaOnnxCreateOfflineSpeechDenoiser(&config);
    if (created == nullptr) {
        result.error = "SherpaOnnxCreateOfflineSpeechDenoiser returned null";
        ENH_LOGE("enhancement Create ==nullptr branch=reject");
        pImpl->owned = {};
        return result;
    }
    pImpl->denoiser = created;
    pImpl->initialized = true;
    pImpl->modelKind = result.modelType;
    ENH_LOGI("enhancement Create ok");

    result.success = true;
    result.sampleRate = SherpaOnnxOfflineSpeechDenoiserGetSampleRate(created);
    return result;
}

EnhancementInitializeResult EnhancementWrapper::initializeCustom(
    const std::string& modelType,
    const EnhancementModelPaths& paths,
    int32_t numThreads,
    const std::optional<std::string>& provider,
    bool debug
) {
    EnhancementInitializeResult result;
    if (pImpl->initialized) {
        release();
    }

    const EnhancementModelKind selectedKind =
        ParseEnhancementModelTypeFromString(modelType);
    if (selectedKind == EnhancementModelKind::kUnknown) {
        result.error = "Unsupported custom enhancement model type";
        return result;
    }

    auto validation = ValidateEnhancementPaths(selectedKind, paths, "custom");
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }
    result.modelType = EnhancementKindToString(selectedKind);
    result.detectedModels.push_back({result.modelType, "custom"});
    SherpaOnnxOfflineSpeechDenoiserConfig config;
    std::memset(&config, 0, sizeof(config));
    FillModelConfig(
        config.model,
        selectedKind,
        paths,
        numThreads,
        provider,
        debug,
        pImpl->owned
    );
    const SherpaOnnxOfflineSpeechDenoiser* created =
        SherpaOnnxCreateOfflineSpeechDenoiser(&config);
    if (created == nullptr) {
        result.error = "SherpaOnnxCreateOfflineSpeechDenoiser returned null";
        ENH_LOGE("enhancement custom Create ==nullptr branch=reject");
        pImpl->owned = {};
        return result;
    }
    pImpl->denoiser = created;
    pImpl->initialized = true;
    pImpl->modelKind = result.modelType;
    ENH_LOGI("enhancement custom Create ok");

    result.success = true;
    result.sampleRate = SherpaOnnxOfflineSpeechDenoiserGetSampleRate(created);
    return result;
}

EnhancedAudioResult EnhancementWrapper::runSamples(
    const std::vector<float>& samples,
    int32_t sampleRate
) {
    if (!pImpl->initialized || pImpl->denoiser == nullptr) {
        return {};
    }
    return FromDenoisedAudio(
        SherpaOnnxOfflineSpeechDenoiserRun(
            pImpl->denoiser,
            samples.data(),
            static_cast<int32_t>(samples.size()),
            sampleRate
        )
    );
}

SetVoiceSampleResult EnhancementWrapper::setVoiceSample(
    const std::vector<float>& samples,
    int32_t sampleRate
) {
    return CallSetVoiceSample(
        "enhancement",
        pImpl->modelKind,
        pImpl->initialized && pImpl->denoiser != nullptr,
        getSampleRate(),
        [this](const float* pcm, int32_t n, int32_t sr) {
            return SherpaOnnxOfflineSpeechDenoiserSetVoiceSample(
                pImpl->denoiser, pcm, n, sr
            );
        },
        samples,
        sampleRate
    );
}

int32_t EnhancementWrapper::getSampleRate() const {
    if (!pImpl->initialized || pImpl->denoiser == nullptr) return 0;
    return SherpaOnnxOfflineSpeechDenoiserGetSampleRate(pImpl->denoiser);
}

bool EnhancementWrapper::isInitialized() const { return pImpl->initialized; }

void EnhancementWrapper::release() { pImpl->destroy(); }

class OnlineEnhancementWrapper::Impl {
public:
    bool initialized = false;
    const SherpaOnnxOnlineSpeechDenoiser* denoiser = nullptr;
    DenoiserOwnedStrings owned;
    std::string modelKind;

    void destroy() {
        if (denoiser != nullptr) {
            SherpaOnnxDestroyOnlineSpeechDenoiser(denoiser);
            denoiser = nullptr;
        }
        initialized = false;
        owned = {};
        modelKind.clear();
    }
};

OnlineEnhancementWrapper::OnlineEnhancementWrapper()
    : pImpl(std::make_unique<Impl>()) {}

OnlineEnhancementWrapper::~OnlineEnhancementWrapper() { release(); }

EnhancementInitializeResult OnlineEnhancementWrapper::initialize(
    const std::string& modelDir,
    const std::string& modelType,
    int32_t numThreads,
    const std::optional<std::string>& provider,
    bool debug
) {
    EnhancementInitializeResult result;
    if (pImpl->initialized) {
        release();
    }
    if (modelDir.empty()) {
        result.error = "Enhancement model directory is empty";
        return result;
    }

    auto detect = DetectEnhancementModel(
        std::optional<std::string>(modelDir),
        std::nullopt,
        modelType
    );
    result.detectedModels = detect.detectedModels;
    result.modelType = EnhancementKindToString(detect.selectedKind);
    if (!detect.ok) {
        result.error = detect.error;
        return result;
    }
    SherpaOnnxOnlineSpeechDenoiserConfig config;
    std::memset(&config, 0, sizeof(config));
    FillModelConfig(
        config.model,
        detect.selectedKind,
        detect.paths,
        numThreads,
        provider,
        debug,
        pImpl->owned
    );
    const SherpaOnnxOnlineSpeechDenoiser* created =
        SherpaOnnxCreateOnlineSpeechDenoiser(&config);
    if (created == nullptr) {
        result.error = "SherpaOnnxCreateOnlineSpeechDenoiser returned null";
        ENH_LOGE("online-enhancement Create ==nullptr branch=reject");
        pImpl->owned = {};
        return result;
    }
    pImpl->denoiser = created;
    pImpl->initialized = true;
    pImpl->modelKind = result.modelType;
    ENH_LOGI("online-enhancement Create ok");

    result.success = true;
    result.sampleRate = SherpaOnnxOnlineSpeechDenoiserGetSampleRate(created);
    result.frameShiftInSamples =
        SherpaOnnxOnlineSpeechDenoiserGetFrameShiftInSamples(created);
    return result;
}

EnhancementInitializeResult OnlineEnhancementWrapper::initializeCustom(
    const std::string& modelType,
    const EnhancementModelPaths& paths,
    int32_t numThreads,
    const std::optional<std::string>& provider,
    bool debug
) {
    EnhancementInitializeResult result;
    if (pImpl->initialized) {
        release();
    }

    const EnhancementModelKind selectedKind =
        ParseEnhancementModelTypeFromString(modelType);
    if (selectedKind == EnhancementModelKind::kUnknown) {
        result.error = "Unsupported custom enhancement model type";
        return result;
    }

    auto validation = ValidateEnhancementPaths(selectedKind, paths, "custom");
    if (!validation.ok) {
        result.error = validation.error;
        return result;
    }
    result.modelType = EnhancementKindToString(selectedKind);
    result.detectedModels.push_back({result.modelType, "custom"});
    SherpaOnnxOnlineSpeechDenoiserConfig config;
    std::memset(&config, 0, sizeof(config));
    FillModelConfig(
        config.model,
        selectedKind,
        paths,
        numThreads,
        provider,
        debug,
        pImpl->owned
    );
    const SherpaOnnxOnlineSpeechDenoiser* created =
        SherpaOnnxCreateOnlineSpeechDenoiser(&config);
    if (created == nullptr) {
        result.error = "SherpaOnnxCreateOnlineSpeechDenoiser returned null";
        ENH_LOGE("online-enhancement custom Create ==nullptr branch=reject");
        pImpl->owned = {};
        return result;
    }
    pImpl->denoiser = created;
    pImpl->initialized = true;
    pImpl->modelKind = result.modelType;
    ENH_LOGI("online-enhancement custom Create ok");

    result.success = true;
    result.sampleRate = SherpaOnnxOnlineSpeechDenoiserGetSampleRate(created);
    result.frameShiftInSamples =
        SherpaOnnxOnlineSpeechDenoiserGetFrameShiftInSamples(created);
    return result;
}

EnhancedAudioResult OnlineEnhancementWrapper::runSamples(
    const std::vector<float>& samples,
    int32_t sampleRate
) {
    if (!pImpl->initialized || pImpl->denoiser == nullptr) {
        return {};
    }
    return FromDenoisedAudio(
        SherpaOnnxOnlineSpeechDenoiserRun(
            pImpl->denoiser,
            samples.data(),
            static_cast<int32_t>(samples.size()),
            sampleRate
        )
    );
}

EnhancedAudioResult OnlineEnhancementWrapper::flush() {
    if (!pImpl->initialized || pImpl->denoiser == nullptr) {
        return {};
    }
    return FromDenoisedAudio(SherpaOnnxOnlineSpeechDenoiserFlush(pImpl->denoiser));
}

void OnlineEnhancementWrapper::reset() {
    if (!pImpl->initialized || pImpl->denoiser == nullptr) return;
    SherpaOnnxOnlineSpeechDenoiserReset(pImpl->denoiser);
}

SetVoiceSampleResult OnlineEnhancementWrapper::setVoiceSample(
    const std::vector<float>& samples,
    int32_t sampleRate
) {
    return CallSetVoiceSample(
        "online-enhancement",
        pImpl->modelKind,
        pImpl->initialized && pImpl->denoiser != nullptr,
        getSampleRate(),
        [this](const float* pcm, int32_t n, int32_t sr) {
            return SherpaOnnxOnlineSpeechDenoiserSetVoiceSample(
                pImpl->denoiser, pcm, n, sr
            );
        },
        samples,
        sampleRate
    );
}

int32_t OnlineEnhancementWrapper::getSampleRate() const {
    if (!pImpl->initialized || pImpl->denoiser == nullptr) return 0;
    return SherpaOnnxOnlineSpeechDenoiserGetSampleRate(pImpl->denoiser);
}

int32_t OnlineEnhancementWrapper::getFrameShiftInSamples() const {
    if (!pImpl->initialized || pImpl->denoiser == nullptr) return 0;
    return SherpaOnnxOnlineSpeechDenoiserGetFrameShiftInSamples(pImpl->denoiser);
}

bool OnlineEnhancementWrapper::isInitialized() const { return pImpl->initialized; }

void OnlineEnhancementWrapper::release() { pImpl->destroy(); }

}  // namespace sherpaonnx
