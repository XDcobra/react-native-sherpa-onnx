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
  config.feat_config.sample_rate = 16000;
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
  if (spotter_ != nullptr) {
    SherpaOnnxDestroyKeywordSpotter(spotter_);
    spotter_ = nullptr;
  }
}

bool KwsWrapper::isInitialized() const {
  return spotter_ != nullptr;
}

}  // namespace sherpaonnx
