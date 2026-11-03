#include "sherpa-onnx-audio-tagging-wrapper.h"

#include <cstdio>
#include <cstring>
#include <string>

#include "sherpa-onnx/c-api/c-api.h"

#ifdef __ANDROID__
#include <android/log.h>
#define AT_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:audioTagging", __VA_ARGS__)
#define AT_LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, "SherpaOnnx:audioTagging", __VA_ARGS__)
#elif defined(__APPLE__)
#define AT_LOGI(...)                                                   \
  do {                                                                 \
    std::fprintf(stderr, "[SherpaOnnx:audioTagging] ");                \
    std::fprintf(stderr, __VA_ARGS__);                                 \
    std::fprintf(stderr, "\n");                                        \
  } while (0)
#define AT_LOGE(...) AT_LOGI(__VA_ARGS__)
#else
#define AT_LOGI(...) ((void)0)
#define AT_LOGE(...) ((void)0)
#endif

namespace sherpaonnx {

class AudioTaggingWrapper::Impl {
 public:
  ~Impl() { release(); }

  AudioTaggingInitializeResult initialize(const std::string& modelType,
                                          const std::string& modelPath,
                                          const std::string& labelsPath,
                                          int32_t topK, int32_t numThreads,
                                          const std::string& provider,
                                          bool debug) {
    release();
    AudioTaggingInitializeResult out;
    if (modelPath.empty() || labelsPath.empty()) {
      out.error = "model and labels paths are required";
      AT_LOGE("init fail: %s", out.error.c_str());
      return out;
    }
    if (modelType != "ced" && modelType != "zipformer") {
      out.error = "modelType must be ced or zipformer";
      AT_LOGE("init fail: %s", out.error.c_str());
      return out;
    }

    modelType_ = modelType;
    modelPath_ = modelPath;
    labelsPath_ = labelsPath;
    provider_ = provider.empty() ? "cpu" : provider;
    defaultTopK_ = topK > 0 ? topK : 5;

    SherpaOnnxAudioTaggingConfig config;
    std::memset(&config, 0, sizeof(config));
    config.model.num_threads = numThreads > 0 ? numThreads : 1;
    config.model.debug = debug ? 1 : 0;
    config.model.provider = provider_.c_str();
    config.labels = labelsPath_.c_str();
    config.top_k = defaultTopK_;

    if (modelType_ == "ced") {
      config.model.ced = modelPath_.c_str();
    } else {
      config.model.zipformer.model = modelPath_.c_str();
    }

    handle_ = SherpaOnnxCreateAudioTagging(&config);
    if (handle_ == nullptr) {
      out.error = "SherpaOnnxCreateAudioTagging returned null";
      AT_LOGE("init fail: %s", out.error.c_str());
      return out;
    }

    out.success = true;
    AT_LOGI("init ok type=%s topK=%d model=%s", modelType_.c_str(),
            defaultTopK_, modelPath_.c_str());
    return out;
  }

  AudioTaggingComputeResult compute(const float* samples, int32_t numSamples,
                                    int32_t sampleRate,
                                    std::optional<int32_t> topKOverride) {
    AudioTaggingComputeResult out;
    if (handle_ == nullptr) {
      out.error = "Audio tagging not initialized";
      return out;
    }
    if (samples == nullptr || numSamples <= 0) {
      out.success = true;
      return out;
    }
    if (sampleRate <= 0) {
      out.error = "sampleRate must be > 0";
      return out;
    }

    const int32_t topK =
        topKOverride.has_value() && topKOverride.value() > 0
            ? topKOverride.value()
            : defaultTopK_;

    const SherpaOnnxOfflineStream* stream =
        SherpaOnnxAudioTaggingCreateOfflineStream(handle_);
    if (stream == nullptr) {
      out.error = "CreateOfflineStream returned null";
      AT_LOGE("compute fail: %s", out.error.c_str());
      return out;
    }

    SherpaOnnxAcceptWaveformOffline(stream, sampleRate, samples, numSamples);
    const SherpaOnnxAudioEvent* const* results =
        SherpaOnnxAudioTaggingCompute(handle_, stream, topK);

    if (results != nullptr) {
      for (int32_t i = 0; results[i] != nullptr; ++i) {
        const SherpaOnnxAudioEvent* ev = results[i];
        AudioTaggingEvent item;
        if (ev->name != nullptr) {
          item.name = ev->name;
        }
        item.index = ev->index;
        item.prob = ev->prob;
        out.events.push_back(std::move(item));
      }
      SherpaOnnxAudioTaggingFreeResults(results);
    }
    SherpaOnnxDestroyOfflineStream(stream);

    out.success = true;
    return out;
  }

  int32_t defaultTopK() const { return defaultTopK_; }

  bool isInitialized() const { return handle_ != nullptr; }

  void release() {
    if (handle_ != nullptr) {
      SherpaOnnxDestroyAudioTagging(handle_);
      handle_ = nullptr;
      AT_LOGI("released");
    }
  }

 private:
  const SherpaOnnxAudioTagging* handle_ = nullptr;
  std::string modelType_;
  std::string modelPath_;
  std::string labelsPath_;
  std::string provider_;
  int32_t defaultTopK_ = 5;
};

AudioTaggingWrapper::AudioTaggingWrapper()
    : pImpl(std::make_unique<Impl>()) {}

AudioTaggingWrapper::~AudioTaggingWrapper() = default;

AudioTaggingInitializeResult AudioTaggingWrapper::initialize(
    const std::string& modelType, const std::string& modelPath,
    const std::string& labelsPath, int32_t topK, int32_t numThreads,
    const std::string& provider, bool debug) {
  return pImpl->initialize(modelType, modelPath, labelsPath, topK, numThreads,
                           provider, debug);
}

AudioTaggingComputeResult AudioTaggingWrapper::compute(
    const float* samples, int32_t numSamples, int32_t sampleRate,
    std::optional<int32_t> topKOverride) {
  return pImpl->compute(samples, numSamples, sampleRate, topKOverride);
}

AudioTaggingComputeResult AudioTaggingWrapper::compute(
    const std::vector<float>& samples, int32_t sampleRate,
    std::optional<int32_t> topKOverride) {
  return pImpl->compute(samples.data(), static_cast<int32_t>(samples.size()),
                        sampleRate, topKOverride);
}

int32_t AudioTaggingWrapper::defaultTopK() const {
  return pImpl->defaultTopK();
}

bool AudioTaggingWrapper::isInitialized() const {
  return pImpl->isInitialized();
}

void AudioTaggingWrapper::release() { pImpl->release(); }

}  // namespace sherpaonnx
