#ifndef SHERPA_ONNX_DIARIZATION_SORTFORMER_STREAMING_MODEL_H
#define SHERPA_ONNX_DIARIZATION_SORTFORMER_STREAMING_MODEL_H

#include "streaming-diarizer-interface.h"
#include "sortformer-fbank.h"
#include "sortformer-post-processor.h"

#include <memory>
#include <string>
#include <vector>

namespace sherpaonnx::diarization {

/**
 * NeMo Sortformer v2.1 streaming diarization model implementation using ONNX Runtime.
 *
 * Implements persistent streaming state (FIFO buffer, speaker cache, silence tracking),
 * NeMo smart cache compression, and zero-allocation inference loops.
 */
class SortformerStreamingModel : public IStreamingDiarizer {
 public:
  SortformerStreamingModel();
  ~SortformerStreamingModel() override;

  Status Initialize(const StreamingDiarizerConfig& config) override;
  bool IsInitialized() const override;
  void Release() override;
  void Reset() override;

  Status ProcessWindow(const float* window, size_t num_samples,
                       int64_t sample_offset,
                       std::vector<DiarizationSegment>& out_segments) override;

  Status Flush(const float* remaining, size_t num_samples,
               int64_t sample_offset,
               std::vector<DiarizationSegment>& out_segments) override;

  const StreamingDiarizerInfo& GetInfo() const override { return info_; }

  // Expose state update and cache compression routines for unit testing
  struct StateSnapshot {
    int32_t fifo_len = 0;
    int32_t spkcache_len = 0;
    int32_t n_sil_frames = 0;
  };

  StateSnapshot GetStateSnapshot() const;

  // Direct test hooks for compression without running ORT session
  void TestSetState(const std::vector<float>& fifo_embs, int32_t fifo_len,
                    const std::vector<float>& fifo_preds,
                    const std::vector<float>& cache_embs, int32_t cache_len,
                    const std::vector<float>& cache_preds,
                    const std::vector<float>& mean_sil_emb, int32_t n_sil_frames);

  void TestCompressCache();
  void TestUpdateSilenceProfile(const float* pop_embs, const float* pop_preds,
                                int32_t num_frames);

  const std::vector<float>& GetSpkCache() const { return spkcache_; }
  const std::vector<float>& GetSpkCachePreds() const { return spkcache_preds_; }
  const std::vector<float>& GetMeanSilEmb() const { return mean_sil_emb_; }

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;

  StreamingDiarizerInfo info_;
  StreamingDiarizerConfig config_;
  std::unique_ptr<SortformerFbank> fbank_;
  std::unique_ptr<SortformerPostProcessor> post_processor_;

  // Persistent streaming state:
  // fifo_: flat row-major (fifo_len_curr, emb_dim)
  // fifo_preds_: flat row-major (fifo_len_curr, max_speakers)
  std::vector<float> fifo_;
  int32_t fifo_len_curr_ = 0;
  std::vector<float> fifo_preds_;

  // spkcache_: flat row-major (spkcache_len_curr, emb_dim)
  // spkcache_preds_: flat row-major (spkcache_len_curr, max_speakers)
  std::vector<float> spkcache_;
  int32_t spkcache_len_curr_ = 0;
  std::vector<float> spkcache_preds_;

  // Running silence tracking
  std::vector<float> mean_sil_emb_;
  int32_t n_sil_frames_ = 0;

  // Internal helpers
  Status LoadMetadata(const std::string& model_path,
                      const std::string& metadata_path);
  void UpdateSilenceProfile(const float* embs, const float* preds,
                            int32_t num_frames);
  void CompressSpkCache();

  Status StreamingUpdate(const float* chunk_feat, int32_t current_len,
                         std::vector<float>& out_chunk_preds,
                         int32_t& out_chunk_len);
};

} // namespace sherpaonnx::diarization

#endif // SHERPA_ONNX_DIARIZATION_SORTFORMER_STREAMING_MODEL_H
