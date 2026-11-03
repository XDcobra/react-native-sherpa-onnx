#ifndef SHERPA_ONNX_AUDIO_TAGGING_WRAPPER_H
#define SHERPA_ONNX_AUDIO_TAGGING_WRAPPER_H

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace sherpaonnx {

struct AudioTaggingEvent {
  std::string name;
  int32_t index = 0;
  float prob = 0.f;
};

struct AudioTaggingInitializeResult {
  bool success = false;
  std::string error;
};

struct AudioTaggingComputeResult {
  bool success = false;
  std::string error;
  std::vector<AudioTaggingEvent> events;
};

/**
 * Shared audio tagging engine (C API). Paths are resolved by JS/detect before init.
 * modelType: "ced" | "zipformer"
 */
class AudioTaggingWrapper {
 public:
  AudioTaggingWrapper();
  ~AudioTaggingWrapper();

  AudioTaggingWrapper(const AudioTaggingWrapper&) = delete;
  AudioTaggingWrapper& operator=(const AudioTaggingWrapper&) = delete;

  AudioTaggingInitializeResult initialize(const std::string& modelType,
                                          const std::string& modelPath,
                                          const std::string& labelsPath,
                                          int32_t topK = 5,
                                          int32_t numThreads = 1,
                                          const std::string& provider = "cpu",
                                          bool debug = false);

  AudioTaggingComputeResult compute(const float* samples, int32_t numSamples,
                                    int32_t sampleRate,
                                    std::optional<int32_t> topKOverride = std::nullopt);

  AudioTaggingComputeResult compute(const std::vector<float>& samples,
                                    int32_t sampleRate,
                                    std::optional<int32_t> topKOverride = std::nullopt);

  int32_t defaultTopK() const;

  bool isInitialized() const;

  void release();

 private:
  class Impl;
  std::unique_ptr<Impl> pImpl;
};

}  // namespace sherpaonnx

#endif
