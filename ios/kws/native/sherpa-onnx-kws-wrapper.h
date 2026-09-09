#pragma once

#include <string>

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

 private:
  const SherpaOnnxKeywordSpotter *spotter_ = nullptr;
};

}  // namespace sherpaonnx
