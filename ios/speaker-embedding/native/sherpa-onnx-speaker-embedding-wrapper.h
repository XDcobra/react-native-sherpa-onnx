#ifndef SHERPA_ONNX_SPEAKER_EMBEDDING_WRAPPER_H
#define SHERPA_ONNX_SPEAKER_EMBEDDING_WRAPPER_H

#include "sherpa-onnx-model-detect.h"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace sherpaonnx {

struct SpeakerEmbeddingInitializeResult {
  bool success = false;
  std::string error;
  std::string modelType;
  int32_t dim = 0;
  std::vector<DetectedModel> detectedModels;
};

class SpeakerEmbeddingExtractorWrapper {
 public:
  SpeakerEmbeddingExtractorWrapper();
  ~SpeakerEmbeddingExtractorWrapper();

  SpeakerEmbeddingInitializeResult initialize(
      const std::string &modelDir,
      const std::string &modelType = "auto",
      int32_t numThreads = 1,
      const std::optional<std::string> &provider = std::nullopt,
      bool debug = false);

  SpeakerEmbeddingInitializeResult initializeCustom(
      const std::string &modelType,
      const SpeakerEmbeddingModelPaths &paths,
      int32_t numThreads = 1,
      const std::optional<std::string> &provider = std::nullopt,
      bool debug = false);

  std::vector<float> computeFromSamples(
      const std::vector<float> &samples,
      int32_t sampleRate);

  int32_t dim() const;
  bool isInitialized() const;
  void release();

 private:
  class Impl;
  std::unique_ptr<Impl> pImpl;
};

class SpeakerEmbeddingManagerWrapper {
 public:
  SpeakerEmbeddingManagerWrapper();
  ~SpeakerEmbeddingManagerWrapper();

  bool create(int32_t dim);
  bool add(
      const std::string &name,
      const std::vector<float> &flattened,
      int32_t count);
  bool remove(const std::string &name);
  std::string search(const std::vector<float> &embedding, float threshold);
  bool verify(
      const std::string &name,
      const std::vector<float> &embedding,
      float threshold);
  bool contains(const std::string &name);
  int32_t numSpeakers() const;
  std::vector<std::string> allSpeakers() const;
  int32_t dim() const;
  bool isInitialized() const;
  void release();

 private:
  class Impl;
  std::unique_ptr<Impl> pImpl;
};

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_SPEAKER_EMBEDDING_WRAPPER_H
