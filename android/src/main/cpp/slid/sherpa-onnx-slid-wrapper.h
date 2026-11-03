#ifndef SHERPA_ONNX_SLID_WRAPPER_H
#define SHERPA_ONNX_SLID_WRAPPER_H

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace sherpaonnx {

struct SlidInitializeResult {
  bool success = false;
  std::string error;
};

struct SlidComputeResult {
  bool success = false;
  std::string lang;
  std::string error;
};

/**
 * Shared Whisper SLID engine (C API). Paths are resolved by JS/detect before init.
 */
class SpokenLanguageIdWrapper {
 public:
  SpokenLanguageIdWrapper();
  ~SpokenLanguageIdWrapper();

  SpokenLanguageIdWrapper(const SpokenLanguageIdWrapper&) = delete;
  SpokenLanguageIdWrapper& operator=(const SpokenLanguageIdWrapper&) = delete;

  SlidInitializeResult initialize(const std::string& encoder,
                                  const std::string& decoder,
                                  int32_t tailPaddings = -1,
                                  int32_t numThreads = 1,
                                  const std::string& provider = "cpu",
                                  bool debug = false);

  SlidComputeResult compute(const float* samples, int32_t numSamples,
                            int32_t sampleRate);

  SlidComputeResult compute(const std::vector<float>& samples,
                            int32_t sampleRate);

  bool isInitialized() const;

  void release();

 private:
  class Impl;
  std::unique_ptr<Impl> pImpl;
};

}  // namespace sherpaonnx

#endif
