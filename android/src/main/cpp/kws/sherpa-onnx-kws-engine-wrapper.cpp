#include "sherpa-onnx-kws-engine-wrapper.h"

#include <algorithm>
#include <cstdio>
#include <cstring>

#ifdef __ANDROID__
#include <android/log.h>
#define KWS_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:kws", __VA_ARGS__)
#define KWS_LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, "SherpaOnnx:kws", __VA_ARGS__)
#elif defined(__APPLE__)
#define KWS_LOGI(...)                                          \
  do {                                                         \
    std::fprintf(stderr, "[SherpaOnnx:kws] ");                 \
    std::fprintf(stderr, __VA_ARGS__);                         \
    std::fprintf(stderr, "\n");                                \
  } while (0)
#define KWS_LOGE(...) KWS_LOGI(__VA_ARGS__)
#else
#define KWS_LOGI(...) ((void)0)
#define KWS_LOGE(...) ((void)0)
#endif

namespace sherpaonnx {

KwsEngineWrapper::~KwsEngineWrapper() { unload(); }

KwsEngineInitResult KwsEngineWrapper::initialize(
    const std::string& encoder,
    const std::string& decoder,
    const std::string& joiner,
    const std::string& tokens,
    const std::string& keywordsFile,
    float keywordsScore,
    float keywordsThreshold,
    int32_t numTrailingBlanks,
    int32_t maxActivePaths,
    int32_t numThreads,
    const std::string& provider,
    bool debug) {
  KwsEngineInitResult result;
  if (spotter_ != nullptr) {
    result.error = "Keyword spotter is already initialized";
    KWS_LOGE("init fail: %s", result.error.c_str());
    return result;
  }
  if (encoder.empty() || decoder.empty() || joiner.empty() || tokens.empty() ||
      keywordsFile.empty()) {
    result.error =
        "encoder, decoder, joiner, tokens, and keywords paths are required";
    KWS_LOGE("init fail: %s", result.error.c_str());
    return result;
  }

  SherpaOnnxKeywordSpotterConfig config;
  std::memset(&config, 0, sizeof(config));
  config.feat_config.sample_rate = sampleRate_;
  config.feat_config.feature_dim = 80;
  config.model_config.transducer.encoder = encoder.c_str();
  config.model_config.transducer.decoder = decoder.c_str();
  config.model_config.transducer.joiner = joiner.c_str();
  config.model_config.tokens = tokens.c_str();
  config.model_config.num_threads = std::max<int32_t>(1, numThreads);
  config.model_config.provider = provider.empty() ? "cpu" : provider.c_str();
  config.model_config.debug = debug ? 1 : 0;
  config.model_config.model_type = "zipformer2";
  config.max_active_paths = maxActivePaths;
  config.num_trailing_blanks = numTrailingBlanks;
  config.keywords_score = keywordsScore;
  config.keywords_threshold = keywordsThreshold;
  config.keywords_file = keywordsFile.c_str();

  spotter_ = SherpaOnnxCreateKeywordSpotter(&config);
  if (spotter_ == nullptr) {
    result.error = "SherpaOnnxCreateKeywordSpotter returned null";
    KWS_LOGE("init fail: %s", result.error.c_str());
    return result;
  }

  KWS_LOGI("initialized zipformer2 sr=%d", sampleRate_);
  result.success = true;
  return result;
}

void KwsEngineWrapper::unload() {
  for (auto& entry : streams_) {
    if (entry.second != nullptr) {
      SherpaOnnxDestroyOnlineStream(entry.second);
    }
  }
  streams_.clear();
  if (spotter_ != nullptr) {
    SherpaOnnxDestroyKeywordSpotter(spotter_);
    spotter_ = nullptr;
  }
}

bool KwsEngineWrapper::isInitialized() const { return spotter_ != nullptr; }

int32_t KwsEngineWrapper::getSampleRate() const { return sampleRate_; }

const SherpaOnnxOnlineStream* KwsEngineWrapper::getStream(
    const std::string& streamId) const {
  auto it = streams_.find(streamId);
  if (it == streams_.end()) {
    return nullptr;
  }
  return it->second;
}

bool KwsEngineWrapper::createStream(
    const std::string& streamId,
    const std::string& keywords) {
  if (spotter_ == nullptr || streamId.empty() || streams_.count(streamId) > 0) {
    return false;
  }
  const SherpaOnnxOnlineStream* stream = nullptr;
  if (keywords.empty()) {
    stream = SherpaOnnxCreateKeywordStream(spotter_);
  } else {
    stream =
        SherpaOnnxCreateKeywordStreamWithKeywords(spotter_, keywords.c_str());
  }
  if (stream == nullptr) {
    KWS_LOGE("createStream failed streamId=%s overrideEmpty=%d",
             streamId.c_str(), keywords.empty() ? 1 : 0);
    return false;
  }
  streams_[streamId] = stream;
  return true;
}

void KwsEngineWrapper::acceptWaveform(
    const std::string& streamId,
    int32_t sampleRate,
    const float* samples,
    size_t n) {
  const SherpaOnnxOnlineStream* stream = getStream(streamId);
  if (stream == nullptr || samples == nullptr || n == 0) {
    return;
  }
  SherpaOnnxOnlineStreamAcceptWaveform(
      stream, sampleRate, samples, static_cast<int32_t>(n));
}

void KwsEngineWrapper::inputFinished(const std::string& streamId) {
  const SherpaOnnxOnlineStream* stream = getStream(streamId);
  if (stream == nullptr) {
    return;
  }
  SherpaOnnxOnlineStreamInputFinished(stream);
}

bool KwsEngineWrapper::isReady(const std::string& streamId) {
  const SherpaOnnxOnlineStream* stream = getStream(streamId);
  if (spotter_ == nullptr || stream == nullptr) {
    return false;
  }
  return SherpaOnnxIsKeywordStreamReady(spotter_, stream) != 0;
}

void KwsEngineWrapper::decode(const std::string& streamId) {
  const SherpaOnnxOnlineStream* stream = getStream(streamId);
  if (spotter_ == nullptr || stream == nullptr) {
    return;
  }
  SherpaOnnxDecodeKeywordStream(spotter_, stream);
}

KwsEngineStreamResult KwsEngineWrapper::getResult(
    const std::string& streamId) {
  KwsEngineStreamResult result;
  const SherpaOnnxOnlineStream* stream = getStream(streamId);
  if (spotter_ == nullptr || stream == nullptr) {
    return result;
  }
  const SherpaOnnxKeywordResult* raw =
      SherpaOnnxGetKeywordResult(spotter_, stream);
  if (raw == nullptr) {
    return result;
  }
  if (raw->keyword != nullptr) {
    result.keyword = raw->keyword;
  }
  if (raw->tokens_arr != nullptr && raw->count > 0) {
    result.tokens.reserve(static_cast<size_t>(raw->count));
    for (int32_t i = 0; i < raw->count; ++i) {
      result.tokens.emplace_back(
          raw->tokens_arr[i] != nullptr ? raw->tokens_arr[i] : "");
    }
  }
  if (raw->timestamps != nullptr && raw->count > 0) {
    result.timestamps.assign(raw->timestamps, raw->timestamps + raw->count);
  }
  result.startTime = raw->start_time;
  SherpaOnnxDestroyKeywordResult(raw);
  return result;
}

void KwsEngineWrapper::resetStream(const std::string& streamId) {
  const SherpaOnnxOnlineStream* stream = getStream(streamId);
  if (spotter_ == nullptr || stream == nullptr) {
    return;
  }
  SherpaOnnxResetKeywordStream(spotter_, stream);
}

void KwsEngineWrapper::releaseStream(const std::string& streamId) {
  auto it = streams_.find(streamId);
  if (it == streams_.end()) {
    return;
  }
  if (it->second != nullptr) {
    SherpaOnnxDestroyOnlineStream(it->second);
  }
  streams_.erase(it);
}

}  // namespace sherpaonnx
