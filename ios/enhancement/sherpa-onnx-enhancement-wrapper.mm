#include "sherpa-onnx-enhancement-wrapper.h"

#include "sherpa-onnx-model-detect.h"

#include <optional>

#include "sherpa-onnx/c-api/cxx-api.h"

namespace sherpaonnx {
namespace {

std::string EnhancementKindToString(EnhancementModelKind kind) {
    switch (kind) {
        case EnhancementModelKind::kGtcrn:
            return "gtcrn";
        case EnhancementModelKind::kDpdfNet:
            return "dpdfnet";
        default:
            return "unknown";
    }
}

sherpa_onnx::cxx::OfflineSpeechDenoiserModelConfig BuildModelConfig(
    const EnhancementDetectResult& detect,
    int32_t numThreads,
    const std::optional<std::string>& provider,
    bool debug
) {
    sherpa_onnx::cxx::OfflineSpeechDenoiserModelConfig cfg;
    cfg.num_threads = numThreads;
    cfg.debug = debug;
    if (provider.has_value() && !provider->empty()) {
        cfg.provider = *provider;
    }
    switch (detect.selectedKind) {
        case EnhancementModelKind::kGtcrn:
            cfg.gtcrn.model = detect.paths.model;
            break;
        case EnhancementModelKind::kDpdfNet:
            cfg.dpdfnet.model = detect.paths.model;
            break;
        default:
            break;
    }
    return cfg;
}

EnhancedAudioResult ToEnhancedAudioResult(
    const sherpa_onnx::cxx::DenoisedAudio& audio
) {
    EnhancedAudioResult out;
    out.samples = audio.samples;
    out.sampleRate = audio.sample_rate;
    return out;
}

} // namespace

class EnhancementWrapper::Impl {
public:
    bool initialized = false;
    std::optional<sherpa_onnx::cxx::OfflineSpeechDenoiser> denoiser;
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

    auto detect = DetectEnhancementModel(modelDir, modelType);
    result.detectedModels = detect.detectedModels;
    result.modelType = EnhancementKindToString(detect.selectedKind);
    if (!detect.ok) {
        result.error = detect.error;
        return result;
    }

    sherpa_onnx::cxx::OfflineSpeechDenoiserConfig config;
    config.model = BuildModelConfig(detect, numThreads, provider, debug);
    pImpl->denoiser = sherpa_onnx::cxx::OfflineSpeechDenoiser::Create(config);
    pImpl->initialized = true;

    result.success = true;
    result.sampleRate = pImpl->denoiser->GetSampleRate();
    return result;
}

EnhancedAudioResult EnhancementWrapper::runSamples(
    const std::vector<float>& samples,
    int32_t sampleRate
) {
    if (!pImpl->initialized || !pImpl->denoiser.has_value()) {
        return {};
    }
    return ToEnhancedAudioResult(
        pImpl->denoiser->Run(samples.data(), static_cast<int32_t>(samples.size()), sampleRate)
    );
}

int32_t EnhancementWrapper::getSampleRate() const {
    if (!pImpl->initialized || !pImpl->denoiser.has_value()) return 0;
    return pImpl->denoiser->GetSampleRate();
}

bool EnhancementWrapper::isInitialized() const { return pImpl->initialized; }

void EnhancementWrapper::release() {
    if (pImpl->denoiser.has_value()) {
        pImpl->denoiser.reset();
    }
    pImpl->initialized = false;
}

class OnlineEnhancementWrapper::Impl {
public:
    bool initialized = false;
    std::optional<sherpa_onnx::cxx::OnlineSpeechDenoiser> denoiser;
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

    auto detect = DetectEnhancementModel(modelDir, modelType);
    result.detectedModels = detect.detectedModels;
    result.modelType = EnhancementKindToString(detect.selectedKind);
    if (!detect.ok) {
        result.error = detect.error;
        return result;
    }

    sherpa_onnx::cxx::OnlineSpeechDenoiserConfig config;
    config.model = BuildModelConfig(detect, numThreads, provider, debug);
    pImpl->denoiser = sherpa_onnx::cxx::OnlineSpeechDenoiser::Create(config);
    pImpl->initialized = true;

    result.success = true;
    result.sampleRate = pImpl->denoiser->GetSampleRate();
    result.frameShiftInSamples = pImpl->denoiser->GetFrameShiftInSamples();
    return result;
}

EnhancedAudioResult OnlineEnhancementWrapper::runSamples(
    const std::vector<float>& samples,
    int32_t sampleRate
) {
    if (!pImpl->initialized || !pImpl->denoiser.has_value()) {
        return {};
    }
    return ToEnhancedAudioResult(
        pImpl->denoiser->Run(samples.data(), static_cast<int32_t>(samples.size()), sampleRate)
    );
}

EnhancedAudioResult OnlineEnhancementWrapper::flush() {
    if (!pImpl->initialized || !pImpl->denoiser.has_value()) {
        return {};
    }
    return ToEnhancedAudioResult(pImpl->denoiser->Flush());
}

void OnlineEnhancementWrapper::reset() {
    if (!pImpl->initialized || !pImpl->denoiser.has_value()) return;
    pImpl->denoiser->Reset();
}

int32_t OnlineEnhancementWrapper::getSampleRate() const {
    if (!pImpl->initialized || !pImpl->denoiser.has_value()) return 0;
    return pImpl->denoiser->GetSampleRate();
}

int32_t OnlineEnhancementWrapper::getFrameShiftInSamples() const {
    if (!pImpl->initialized || !pImpl->denoiser.has_value()) return 0;
    return pImpl->denoiser->GetFrameShiftInSamples();
}

bool OnlineEnhancementWrapper::isInitialized() const { return pImpl->initialized; }

void OnlineEnhancementWrapper::release() {
    if (pImpl->denoiser.has_value()) {
        pImpl->denoiser.reset();
    }
    pImpl->initialized = false;
}

} // namespace sherpaonnx
