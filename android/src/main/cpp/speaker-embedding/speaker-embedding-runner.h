#ifndef SHERPA_ONNX_SPEAKER_EMBEDDING_RUNNER_H
#define SHERPA_ONNX_SPEAKER_EMBEDDING_RUNNER_H

#include "speaker-embedding-types.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace sherpaonnx::speaker_embedding {

struct EmbeddingRunnerOptions {
  std::string model_path;
  int32_t num_threads = 1;
  std::string provider = "cpu";
  bool debug = false;
};

/**
 * Process-wide, refcounted speaker-embedding extractor over the sherpa-onnx
 * C API. Keyed by (model_path, provider, num_threads, debug). Shared by SID
 * and diarization.
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

  /**
   * Compute an embedding. Empty `ranges` means the full buffer
   * `[0, num_samples)`. Concurrent Compute calls on a shared extractor are
   * serialized by a per-extractor mutex.
   */
  Status Compute(const float* audio, int32_t num_samples, int32_t sample_rate,
                 const std::vector<SampleRange>& ranges,
                 std::vector<float>* out_embedding) const;

  /** Convenience: full-buffer compute (empty ranges). */
  Status ComputeFull(const float* audio, int32_t num_samples,
                     int32_t sample_rate,
                     std::vector<float>* out_embedding) const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace sherpaonnx::speaker_embedding

#endif  // SHERPA_ONNX_SPEAKER_EMBEDDING_RUNNER_H
