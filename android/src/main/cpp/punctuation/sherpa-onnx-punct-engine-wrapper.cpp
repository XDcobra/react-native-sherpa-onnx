#include "sherpa-onnx-punct-engine-wrapper.h"

#include <cstdio>
#include <cstring>
#include <string>

#include "sherpa-onnx/c-api/c-api.h"

#ifdef __ANDROID__
#include <android/log.h>
#define PUNCT_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:punctuation", __VA_ARGS__)
#define PUNCT_LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, "SherpaOnnx:punctuation", __VA_ARGS__)
#elif defined(__APPLE__)
#define PUNCT_LOGI(...)                                                \
  do {                                                                 \
    std::fprintf(stderr, "[SherpaOnnx:punctuation] ");                 \
    std::fprintf(stderr, __VA_ARGS__);                                 \
    std::fprintf(stderr, "\n");                                        \
  } while (0)
#define PUNCT_LOGE(...) PUNCT_LOGI(__VA_ARGS__)
#else
#define PUNCT_LOGI(...) ((void)0)
#define PUNCT_LOGE(...) ((void)0)
#endif

namespace sherpaonnx {

// --- Offline ---

class OfflinePunctuationWrapper::Impl {
 public:
  ~Impl() { release(); }

  PunctuationInitializeResult initialize(const std::string& ctTransformerPath,
                                         int32_t numThreads,
                                         const std::string& provider,
                                         bool debug) {
    release();
    PunctuationInitializeResult out;
    if (ctTransformerPath.empty()) {
      out.error = "ct_transformer path is required";
      PUNCT_LOGE("offline init fail: %s", out.error.c_str());
      return out;
    }

    ctPath_ = ctTransformerPath;
    provider_ = provider.empty() ? "cpu" : provider;

    SherpaOnnxOfflinePunctuationConfig config;
    std::memset(&config, 0, sizeof(config));
    config.model.ct_transformer = ctPath_.c_str();
    config.model.num_threads = numThreads > 0 ? numThreads : 1;
    config.model.debug = debug ? 1 : 0;
    config.model.provider = provider_.c_str();

    handle_ = SherpaOnnxCreateOfflinePunctuation(&config);
    if (handle_ == nullptr) {
      out.error = "SherpaOnnxCreateOfflinePunctuation returned null";
      PUNCT_LOGE("offline init fail: %s", out.error.c_str());
      return out;
    }

    out.success = true;
    PUNCT_LOGI("offline init ok model=%s", ctPath_.c_str());
    return out;
  }

  PunctuationAddResult addPunctuation(const std::string& text) {
    PunctuationAddResult out;
    if (handle_ == nullptr) {
      out.error = "Offline punctuation not initialized";
      return out;
    }
    const char* result =
        SherpaOfflinePunctuationAddPunct(handle_, text.c_str());
    if (result == nullptr) {
      out.error = "SherpaOfflinePunctuationAddPunct returned null";
      PUNCT_LOGE("offline addPunct fail: %s", out.error.c_str());
      return out;
    }
    out.text = result;
    SherpaOfflinePunctuationFreeText(result);
    out.success = true;
    return out;
  }

  bool isInitialized() const { return handle_ != nullptr; }

  void release() {
    if (handle_ != nullptr) {
      SherpaOnnxDestroyOfflinePunctuation(handle_);
      handle_ = nullptr;
      PUNCT_LOGI("offline released");
    }
  }

 private:
  const SherpaOnnxOfflinePunctuation* handle_ = nullptr;
  std::string ctPath_;
  std::string provider_;
};

OfflinePunctuationWrapper::OfflinePunctuationWrapper()
    : pImpl(std::make_unique<Impl>()) {}

OfflinePunctuationWrapper::~OfflinePunctuationWrapper() = default;

PunctuationInitializeResult OfflinePunctuationWrapper::initialize(
    const std::string& ctTransformerPath, int32_t numThreads,
    const std::string& provider, bool debug) {
  return pImpl->initialize(ctTransformerPath, numThreads, provider, debug);
}

PunctuationAddResult OfflinePunctuationWrapper::addPunctuation(
    const std::string& text) {
  return pImpl->addPunctuation(text);
}

bool OfflinePunctuationWrapper::isInitialized() const {
  return pImpl->isInitialized();
}

void OfflinePunctuationWrapper::release() { pImpl->release(); }

// --- Online ---

class OnlinePunctuationWrapper::Impl {
 public:
  ~Impl() { release(); }

  PunctuationInitializeResult initialize(const std::string& cnnBilstmPath,
                                         const std::string& bpeVocabPath,
                                         int32_t numThreads,
                                         const std::string& provider,
                                         bool debug) {
    release();
    PunctuationInitializeResult out;
    if (cnnBilstmPath.empty() || bpeVocabPath.empty()) {
      out.error = "cnn_bilstm and bpe_vocab paths are required";
      PUNCT_LOGE("online init fail: %s", out.error.c_str());
      return out;
    }

    cnnPath_ = cnnBilstmPath;
    bpePath_ = bpeVocabPath;
    provider_ = provider.empty() ? "cpu" : provider;

    SherpaOnnxOnlinePunctuationConfig config;
    std::memset(&config, 0, sizeof(config));
    config.model.cnn_bilstm = cnnPath_.c_str();
    config.model.bpe_vocab = bpePath_.c_str();
    config.model.num_threads = numThreads > 0 ? numThreads : 1;
    config.model.debug = debug ? 1 : 0;
    config.model.provider = provider_.c_str();

    handle_ = SherpaOnnxCreateOnlinePunctuation(&config);
    if (handle_ == nullptr) {
      out.error = "SherpaOnnxCreateOnlinePunctuation returned null";
      PUNCT_LOGE("online init fail: %s", out.error.c_str());
      return out;
    }

    out.success = true;
    PUNCT_LOGI("online init ok model=%s bpe=%s", cnnPath_.c_str(),
               bpePath_.c_str());
    return out;
  }

  PunctuationAddResult addPunctuation(const std::string& text) {
    PunctuationAddResult out;
    if (handle_ == nullptr) {
      out.error = "Online punctuation not initialized";
      return out;
    }
    const char* result =
        SherpaOnnxOnlinePunctuationAddPunct(handle_, text.c_str());
    if (result == nullptr) {
      out.error = "SherpaOnnxOnlinePunctuationAddPunct returned null";
      PUNCT_LOGE("online addPunct fail: %s", out.error.c_str());
      return out;
    }
    out.text = result;
    SherpaOnnxOnlinePunctuationFreeText(result);
    out.success = true;
    return out;
  }

  bool isInitialized() const { return handle_ != nullptr; }

  void release() {
    if (handle_ != nullptr) {
      SherpaOnnxDestroyOnlinePunctuation(handle_);
      handle_ = nullptr;
      PUNCT_LOGI("online released");
    }
  }

 private:
  const SherpaOnnxOnlinePunctuation* handle_ = nullptr;
  std::string cnnPath_;
  std::string bpePath_;
  std::string provider_;
};

OnlinePunctuationWrapper::OnlinePunctuationWrapper()
    : pImpl(std::make_unique<Impl>()) {}

OnlinePunctuationWrapper::~OnlinePunctuationWrapper() = default;

PunctuationInitializeResult OnlinePunctuationWrapper::initialize(
    const std::string& cnnBilstmPath, const std::string& bpeVocabPath,
    int32_t numThreads, const std::string& provider, bool debug) {
  return pImpl->initialize(cnnBilstmPath, bpeVocabPath, numThreads, provider,
                           debug);
}

PunctuationAddResult OnlinePunctuationWrapper::addPunctuation(
    const std::string& text) {
  return pImpl->addPunctuation(text);
}

bool OnlinePunctuationWrapper::isInitialized() const {
  return pImpl->isInitialized();
}

void OnlinePunctuationWrapper::release() { pImpl->release(); }

}  // namespace sherpaonnx
