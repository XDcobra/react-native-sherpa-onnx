#include "sherpa-onnx-slid-wrapper.h"

#include <cstdio>
#include <cstring>
#include <string>

#include "sherpa-onnx/c-api/c-api.h"

#ifdef __ANDROID__
#include <android/log.h>
#define SLID_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:slid", __VA_ARGS__)
#define SLID_LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, "SherpaOnnx:slid", __VA_ARGS__)
#elif defined(__APPLE__)
#define SLID_LOGI(...)                                      \
  do {                                                      \
    std::fprintf(stderr, "[SherpaOnnx:slid] ");             \
    std::fprintf(stderr, __VA_ARGS__);                      \
    std::fprintf(stderr, "\n");                             \
  } while (0)
#define SLID_LOGE(...) SLID_LOGI(__VA_ARGS__)
#else
#define SLID_LOGI(...) ((void)0)
#define SLID_LOGE(...) ((void)0)
#endif

namespace sherpaonnx {

class SpokenLanguageIdWrapper::Impl {
 public:
  ~Impl() { release(); }

  SlidInitializeResult initialize(const std::string& encoder,
                                  const std::string& decoder,
                                  int32_t tailPaddings, int32_t numThreads,
                                  const std::string& provider, bool debug) {
    release();
    SlidInitializeResult out;
    if (encoder.empty() || decoder.empty()) {
      out.error = "encoder and decoder paths are required";
      SLID_LOGE("init fail: %s", out.error.c_str());
      return out;
    }

    encoder_ = encoder;
    decoder_ = decoder;
    provider_ = provider.empty() ? "cpu" : provider;

    SherpaOnnxSpokenLanguageIdentificationConfig config;
    std::memset(&config, 0, sizeof(config));
    config.whisper.encoder = encoder_.c_str();
    config.whisper.decoder = decoder_.c_str();
    config.whisper.tail_paddings = tailPaddings;
    config.num_threads = numThreads > 0 ? numThreads : 1;
    config.debug = debug ? 1 : 0;
    config.provider = provider_.c_str();

    handle_ = SherpaOnnxCreateSpokenLanguageIdentification(&config);
    if (handle_ == nullptr) {
      out.error = "SherpaOnnxCreateSpokenLanguageIdentification returned null";
      SLID_LOGE("init fail: %s", out.error.c_str());
      return out;
    }

    out.success = true;
    SLID_LOGI("init ok encoder=%s decoder=%s threads=%d provider=%s",
              encoder_.c_str(), decoder_.c_str(), config.num_threads,
              provider_.c_str());
    return out;
  }

  SlidComputeResult compute(const float* samples, int32_t numSamples,
                            int32_t sampleRate) {
    SlidComputeResult out;
    if (handle_ == nullptr) {
      out.error = "SLID not initialized";
      return out;
    }
    if (samples == nullptr || numSamples <= 0) {
      out.success = true;
      out.lang = "";
      return out;
    }
    if (sampleRate <= 0) {
      out.error = "sampleRate must be > 0";
      return out;
    }

    SherpaOnnxOfflineStream* stream =
        SherpaOnnxSpokenLanguageIdentificationCreateOfflineStream(handle_);
    if (stream == nullptr) {
      out.error = "CreateOfflineStream returned null";
      SLID_LOGE("compute fail: %s", out.error.c_str());
      return out;
    }

    SherpaOnnxAcceptWaveformOffline(stream, sampleRate, samples, numSamples);
    const SherpaOnnxSpokenLanguageIdentificationResult* result =
        SherpaOnnxSpokenLanguageIdentificationCompute(handle_, stream);
    SherpaOnnxDestroyOfflineStream(stream);

    if (result == nullptr) {
      out.error = "SpokenLanguageIdentificationCompute returned null";
      SLID_LOGE("compute fail: %s", out.error.c_str());
      return out;
    }

    if (result->lang != nullptr) {
      out.lang = result->lang;
    }
    SherpaOnnxDestroySpokenLanguageIdentificationResult(result);

    // Trim whitespace (parity with iOS live worker).
    while (!out.lang.empty() &&
           (out.lang.back() == ' ' || out.lang.back() == '\t' ||
            out.lang.back() == '\n' || out.lang.back() == '\r')) {
      out.lang.pop_back();
    }
    size_t start = 0;
    while (start < out.lang.size() &&
           (out.lang[start] == ' ' || out.lang[start] == '\t' ||
            out.lang[start] == '\n' || out.lang[start] == '\r')) {
      ++start;
    }
    if (start > 0) {
      out.lang = out.lang.substr(start);
    }

    out.success = true;
    return out;
  }

  bool isInitialized() const { return handle_ != nullptr; }

  void release() {
    if (handle_ != nullptr) {
      SherpaOnnxDestroySpokenLanguageIdentification(handle_);
      handle_ = nullptr;
      SLID_LOGI("released");
    }
  }

 private:
  const SherpaOnnxSpokenLanguageIdentification* handle_ = nullptr;
  std::string encoder_;
  std::string decoder_;
  std::string provider_;
};

SpokenLanguageIdWrapper::SpokenLanguageIdWrapper()
    : pImpl(std::make_unique<Impl>()) {}

SpokenLanguageIdWrapper::~SpokenLanguageIdWrapper() = default;

SlidInitializeResult SpokenLanguageIdWrapper::initialize(
    const std::string& encoder, const std::string& decoder,
    int32_t tailPaddings, int32_t numThreads, const std::string& provider,
    bool debug) {
  return pImpl->initialize(encoder, decoder, tailPaddings, numThreads, provider,
                           debug);
}

SlidComputeResult SpokenLanguageIdWrapper::compute(const float* samples,
                                                   int32_t numSamples,
                                                   int32_t sampleRate) {
  return pImpl->compute(samples, numSamples, sampleRate);
}

SlidComputeResult SpokenLanguageIdWrapper::compute(
    const std::vector<float>& samples, int32_t sampleRate) {
  return pImpl->compute(samples.data(), static_cast<int32_t>(samples.size()),
                        sampleRate);
}

bool SpokenLanguageIdWrapper::isInitialized() const {
  return pImpl->isInitialized();
}

void SpokenLanguageIdWrapper::release() { pImpl->release(); }

}  // namespace sherpaonnx
