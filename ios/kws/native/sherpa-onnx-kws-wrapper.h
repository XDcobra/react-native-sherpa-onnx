#pragma once

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

struct KwsInitResult {
  bool success = false;
  std::string error;
};

struct KwsStreamResult {
  std::string keyword;
  std::vector<std::string> tokens;
  std::vector<float> timestamps;
  float startTime = 0.0f;
};

class KwsWrapper {
 public:
  KwsWrapper() = default;
  ~KwsWrapper();

  KwsWrapper(const KwsWrapper &) = delete;
  KwsWrapper &operator=(const KwsWrapper &) = delete;

  KwsInitResult initialize(
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
      bool debug);

  void unload();
  bool isInitialized() const;
  int32_t getSampleRate() const;

  bool createStream(const std::string &streamId, const std::string &keywords);
  void acceptWaveform(
      const std::string &streamId,
      int32_t sampleRate,
      const float *samples,
      size_t n);
  void inputFinished(const std::string &streamId);
  bool isReady(const std::string &streamId);
  void decode(const std::string &streamId);
  KwsStreamResult getResult(const std::string &streamId);
  void resetStream(const std::string &streamId);
  void releaseStream(const std::string &streamId);

 private:
  const SherpaOnnxOnlineStream *getStream(const std::string &streamId) const;

  const SherpaOnnxKeywordSpotter *spotter_ = nullptr;
  int32_t sampleRate_ = 16000;
  std::unordered_map<std::string, const SherpaOnnxOnlineStream *> streams_;
};

}  // namespace sherpaonnx
