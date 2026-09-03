#ifndef SHERPA_ONNX_DIARIZATION_SPEAKER_EMBEDDING_RUNNER_H
#define SHERPA_ONNX_DIARIZATION_SPEAKER_EMBEDDING_RUNNER_H

#include "diarization-types.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace sherpaonnx::diarization {

struct EmbeddingRunnerOptions {
  std::string model_path;
  int32_t num_threads = 1;
  std::string provider = "cpu";
  bool debug = false;
};

/**
 * Shared, refcounted speaker-embedding extractor over the sherpa-onnx C API.
 * Keyed by (model_path, provider, num_threads). SID can later share this registry.
 */
class SpeakerEmbeddingRunner {
 public:
  SpeakerEmbeddingRunner();
  ~SpeakerEmbeddingRunner();

  SpeakerEmbeddingRunner(const SpeakerEmbeddingRunner&) = delete;
  SpeakerEmbeddingRunner& operator=(const SpeakerEmbeddingRunner&) = delete;

  Status Acquire(const EmbeddingRunnerOptions& options);
  void Release();

  bool isReady() const;
  int32_t dim() const;

  Status Compute(const float* audio, int32_t num_samples, int32_t sample_rate,
                 const std::vector<SampleRange>& ranges,
                 std::vector<float>* out_embedding) const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace sherpaonnx::diarization

#endif  // SHERPA_ONNX_DIARIZATION_SPEAKER_EMBEDDING_RUNNER_H
