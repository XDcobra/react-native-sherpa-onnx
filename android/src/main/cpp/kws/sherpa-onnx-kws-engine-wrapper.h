#ifndef SHERPA_ONNX_KWS_ENGINE_WRAPPER_H
#define SHERPA_ONNX_KWS_ENGINE_WRAPPER_H

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#if __has_include(<sherpa-onnx/c-api/c-api.h>)
#include <sherpa-onnx/c-api/c-api.h>
#elif __has_include("sherpa-onnx/c-api/c-api.h")
#include "sherpa-onnx/c-api/c-api.h"
#else
#include "../../../third_party/sherpa-onnx/sherpa-onnx/c-api/c-api.h"
#endif

namespace sherpaonnx {

struct KwsEngineInitResult {
  bool success = false;
  std::string error;
};

struct KwsEngineStreamResult {
  std::string keyword;
  std::vector<std::string> tokens;
  std::vector<float> timestamps;
  float startTime = 0.0f;
};

/**
 * Shared KeywordSpotter (C API). Paths resolved by JS/detect before init.
 * Hard-coded: model_type=zipformer2, sample_rate=16000, feature_dim=80.
 */
class KwsEngineWrapper {
 public:
  KwsEngineWrapper() = default;
  ~KwsEngineWrapper();

  KwsEngineWrapper(const KwsEngineWrapper&) = delete;
  KwsEngineWrapper& operator=(const KwsEngineWrapper&) = delete;

  KwsEngineInitResult initialize(
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
      bool debug);

  void unload();
  bool isInitialized() const;
  int32_t getSampleRate() const;

  bool createStream(const std::string& streamId, const std::string& keywords);
  void acceptWaveform(
      const std::string& streamId,
      int32_t sampleRate,
      const float* samples,
      size_t n);
  void inputFinished(const std::string& streamId);
  bool isReady(const std::string& streamId);
  void decode(const std::string& streamId);
  KwsEngineStreamResult getResult(const std::string& streamId);
  void resetStream(const std::string& streamId);
  void releaseStream(const std::string& streamId);

 private:
  const SherpaOnnxOnlineStream* getStream(const std::string& streamId) const;

  const SherpaOnnxKeywordSpotter* spotter_ = nullptr;
  int32_t sampleRate_ = 16000;
  std::unordered_map<std::string, const SherpaOnnxOnlineStream*> streams_;
};

}  // namespace sherpaonnx

#endif
