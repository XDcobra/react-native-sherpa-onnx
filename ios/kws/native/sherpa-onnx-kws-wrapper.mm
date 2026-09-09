#include "sherpa-onnx-kws-wrapper.h"

#include <algorithm>
#include <cstring>

namespace sherpaonnx {

KwsWrapper::~KwsWrapper() {
  unload();
}

KwsInitResult KwsWrapper::initialize(
    const std::string &encoder,
    const std::string &decoder,
    const std::string &joiner,
    const std::string &tokens,
    const std::string &keywords,
    float keywordsScore,
    float keywordsThreshold,
    int32_t numTrailingBlanks,
    int32_t maxActivePaths,
    int32_t numThreads,
    const std::string &provider,
    bool debug) {
  KwsInitResult result;
  if (spotter_ != nullptr) {
    result.error = "Keyword spotter is already initialized";
    return result;
  }
  if (encoder.empty() || decoder.empty() || joiner.empty() ||
      tokens.empty() || keywords.empty()) {
    result.error =
        "encoder, decoder, joiner, tokens, and keywords paths are required";
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
  config.keywords_file = keywords.c_str();

  spotter_ = SherpaOnnxCreateKeywordSpotter(&config);
  if (spotter_ == nullptr) {
    result.error = "SherpaOnnxCreateKeywordSpotter returned null";
    return result;
  }

  result.success = true;
  return result;
}

void KwsWrapper::unload() {
  for (auto &entry : streams_) {
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

bool KwsWrapper::isInitialized() const {
  return spotter_ != nullptr;
}

int32_t KwsWrapper::getSampleRate() const {
  return sampleRate_;
}

const SherpaOnnxOnlineStream *KwsWrapper::getStream(
    const std::string &streamId) const {
  auto it = streams_.find(streamId);
  if (it == streams_.end()) {
    return nullptr;
  }
  return it->second;
}

bool KwsWrapper::createStream(
    const std::string &streamId,
    const std::string &keywords) {
  if (spotter_ == nullptr || streamId.empty() || streams_.count(streamId) > 0) {
    return false;
  }
  const SherpaOnnxOnlineStream *stream = nullptr;
  if (keywords.empty()) {
    stream = SherpaOnnxCreateKeywordStream(spotter_);
  } else {
    stream = SherpaOnnxCreateKeywordStreamWithKeywords(
        spotter_, keywords.c_str());
  }
  if (stream == nullptr) {
    return false;
  }
  streams_[streamId] = stream;
  return true;
}

void KwsWrapper::acceptWaveform(
    const std::string &streamId,
    int32_t sampleRate,
    const float *samples,
    size_t n) {
  const SherpaOnnxOnlineStream *stream = getStream(streamId);
  if (stream == nullptr || samples == nullptr || n == 0) {
    return;
  }
  SherpaOnnxOnlineStreamAcceptWaveform(
      stream, sampleRate, samples, static_cast<int32_t>(n));
}

void KwsWrapper::inputFinished(const std::string &streamId) {
  const SherpaOnnxOnlineStream *stream = getStream(streamId);
  if (stream == nullptr) {
    return;
  }
  SherpaOnnxOnlineStreamInputFinished(stream);
}

bool KwsWrapper::isReady(const std::string &streamId) {
  const SherpaOnnxOnlineStream *stream = getStream(streamId);
  if (spotter_ == nullptr || stream == nullptr) {
    return false;
  }
  return SherpaOnnxIsKeywordStreamReady(spotter_, stream) != 0;
}

void KwsWrapper::decode(const std::string &streamId) {
  const SherpaOnnxOnlineStream *stream = getStream(streamId);
  if (spotter_ == nullptr || stream == nullptr) {
    return;
  }
  SherpaOnnxDecodeKeywordStream(spotter_, stream);
}

KwsStreamResult KwsWrapper::getResult(const std::string &streamId) {
  KwsStreamResult result;
  const SherpaOnnxOnlineStream *stream = getStream(streamId);
  if (spotter_ == nullptr || stream == nullptr) {
    return result;
  }
  const SherpaOnnxKeywordResult *raw =
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

void KwsWrapper::resetStream(const std::string &streamId) {
  const SherpaOnnxOnlineStream *stream = getStream(streamId);
  if (spotter_ == nullptr || stream == nullptr) {
    return;
  }
  SherpaOnnxResetKeywordStream(spotter_, stream);
}

void KwsWrapper::releaseStream(const std::string &streamId) {
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
