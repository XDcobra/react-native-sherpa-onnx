#ifndef SHERPA_ONNX_DIARIZATION_SESSION_H
#define SHERPA_ONNX_DIARIZATION_SESSION_H

#include "agglomerative-clustering.h"
#include "diarization-types.h"
#include "pyannote-segmentation-model.h"
#include "speaker-embedding-runner.h"
#include "speaker-timeline.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace sherpaonnx::diarization {

struct DiarizationInitConfig {
  std::string segmentation_model;
  std::string embedding_model;
  float window_shift_ratio = 0.1f;
  int32_t num_clusters = -1;
  float threshold = 0.5f;
  float min_duration_on = 0.3f;
  float min_duration_off = 0.5f;
  int32_t num_threads = 1;
  std::string provider = "cpu";
  bool debug = false;
};

struct DiarizationProgress {
  /** 0..1 overall */
  float fraction = 0.f;
  /** "segmentation" | "embedding" | "clustering" */
  std::string phase;
  int32_t current = 0;
  int32_t total = 0;
};

using ProgressFn = std::function<void(const DiarizationProgress&)>;

struct ProcessOptions {
  bool include_overlap = false;
  ProgressFn on_progress;
};

struct ProcessResult {
  Status status;
  std::vector<DiarizationSegment> segments;
  int32_t num_speakers = 0;
  /** Optional: speakers active per frame (only if include_overlap). */
  std::vector<int32_t> speakers_per_frame;
  int32_t sample_rate = 0;
};

struct ClusterEmbedding {
  int32_t speaker = 0;
  std::vector<float> embedding;
};

/**
 * Orchestrates segmentation → embeddings → clustering with cancel + recluster.
 */
class DiarizationSession {
 public:
  DiarizationSession();
  ~DiarizationSession();

  Status Initialize(const DiarizationInitConfig& config);
  void Release();
  bool isInitialized() const;

  int32_t sampleRate() const;

  void setClustering(int32_t num_clusters, float threshold);
  void requestCancel();
  void clearCancel();

  ProcessResult Process(const std::vector<float>& mono_samples,
                        int32_t sample_rate, const ProcessOptions& options);

  /** Re-run clustering on cached embeddings (no re-inference). */
  ProcessResult Recluster(int32_t num_clusters, float threshold);

  std::vector<ClusterEmbedding> getClusterEmbeddings() const;

 private:
  ProcessResult FinishFromCache(const ProcessOptions& options);
  std::vector<float> ResampleIfNeeded(const std::vector<float>& input,
                                      int32_t src_rate, int32_t dst_rate) const;

  PyannoteSegmentationModel segmentation_;
  ::sherpaonnx::speaker_embedding::SpeakerEmbeddingRunner embedding_;
  AgglomerativeClusterer clusterer_{ClusteringConfig{}};
  TimelineConfig timeline_config_{};

  std::atomic<bool> cancel_{false};
  bool initialized_ = false;

  // Cache for recluster
  std::vector<Int8Matrix> chunk_labels_;
  std::vector<int32_t> speakers_per_frame_;
  std::vector<ChunkSpeakerKey> chunk_speaker_keys_;
  FloatMatrix embedding_matrix_;
  std::vector<int32_t> last_cluster_labels_;
  std::vector<DiarizationSegment> last_segments_;
  int32_t last_num_samples_ = 0;
  int32_t working_sample_rate_ = 0;
};

}  // namespace sherpaonnx::diarization

#endif  // SHERPA_ONNX_DIARIZATION_SESSION_H
