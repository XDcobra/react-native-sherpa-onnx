#ifndef SHERPA_ONNX_DIARIZATION_AGGLOMERATIVE_CLUSTERING_H
#define SHERPA_ONNX_DIARIZATION_AGGLOMERATIVE_CLUSTERING_H

#include "diarization-types.h"

#include <cstdint>
#include <vector>

namespace sherpaonnx::diarization {

struct ClusteringConfig {
  /** If > 0, cut the dendrogram to exactly this many clusters. */
  int32_t num_clusters = -1;
  /** Cosine-dissimilarity threshold used when num_clusters <= 0. */
  float threshold = 0.5f;
};

/**
 * Complete-linkage agglomerative clustering on L2-normalized rows,
 * using cosine dissimilarity (1 - cos). Deterministic tie-breaks.
 */
class AgglomerativeClusterer {
 public:
  explicit AgglomerativeClusterer(ClusteringConfig config);

  void setConfig(ClusteringConfig config);

  /**
   * \p features row-major (num_rows × num_cols). Modified in place (row normalize).
   * Returns cluster label per row in [0, num_clusters).
   */
  std::vector<int32_t> Cluster(float* features, int32_t num_rows,
                               int32_t num_cols) const;

 private:
  ClusteringConfig config_;
};

}  // namespace sherpaonnx::diarization

#endif  // SHERPA_ONNX_DIARIZATION_AGGLOMERATIVE_CLUSTERING_H
