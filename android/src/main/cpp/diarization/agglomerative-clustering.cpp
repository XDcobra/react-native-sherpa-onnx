#include "agglomerative-clustering.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>

namespace sherpaonnx::diarization {
namespace {

void NormalizeRows(float* features, int32_t num_rows, int32_t num_cols) {
  for (int32_t r = 0; r < num_rows; ++r) {
    float* row =
        features + static_cast<size_t>(r) * static_cast<size_t>(num_cols);
    double sum_sq = 0.0;
    for (int32_t c = 0; c < num_cols; ++c) {
      sum_sq += static_cast<double>(row[c]) * row[c];
    }
    const double norm = std::sqrt(std::max(sum_sq, 1e-12));
    for (int32_t c = 0; c < num_cols; ++c) {
      row[c] = static_cast<float>(row[c] / norm);
    }
  }
}

double CosineDissimilarity(const float* a, const float* b, int32_t dim) {
  double dot = 0.0;
  for (int32_t i = 0; i < dim; ++i) {
    dot += static_cast<double>(a[i]) * b[i];
  }
  double d = 1.0 - dot;
  if (d < 0.0) {
    d = 0.0;
  }
  return d;
}

size_t CondensedIndex(int32_t n, int32_t i, int32_t j) {
  return static_cast<size_t>(n) * static_cast<size_t>(i) -
         static_cast<size_t>(i) * static_cast<size_t>(i + 1) / 2 +
         static_cast<size_t>(j - i - 1);
}

struct Merge {
  int32_t left = 0;
  int32_t right = 0;
  double height = 0.0;
};

std::vector<Merge> LinkageComplete(const std::vector<double>& dist, int32_t n) {
  std::vector<Merge> merges;
  merges.reserve(static_cast<size_t>(std::max(0, n - 1)));
  if (n <= 1) {
    return merges;
  }

  std::vector<int32_t> active(static_cast<size_t>(n));
  std::iota(active.begin(), active.end(), 0);

  const int32_t max_id = 2 * n;
  std::vector<double> cluster_dist(
      static_cast<size_t>(max_id) * static_cast<size_t>(max_id),
      std::numeric_limits<double>::infinity());

  auto at = [&](int32_t i, int32_t j) -> double& {
    return cluster_dist[static_cast<size_t>(i) * static_cast<size_t>(max_id) +
                        static_cast<size_t>(j)];
  };

  for (int32_t i = 0; i < n; ++i) {
    for (int32_t j = i + 1; j < n; ++j) {
      const double d = dist[CondensedIndex(n, i, j)];
      at(i, j) = d;
      at(j, i) = d;
    }
  }

  int32_t next_id = n;
  while (active.size() > 1) {
    double best = std::numeric_limits<double>::infinity();
    size_t best_a = 0;
    size_t best_b = 1;
    for (size_t a = 0; a < active.size(); ++a) {
      for (size_t b = a + 1; b < active.size(); ++b) {
        const int32_t i = active[a];
        const int32_t j = active[b];
        const double d = at(i, j);
        const bool better =
            d < best ||
            (d == best &&
             (std::min(i, j) < std::min(active[best_a], active[best_b]) ||
              (std::min(i, j) == std::min(active[best_a], active[best_b]) &&
               std::max(i, j) < std::max(active[best_a], active[best_b]))));
        if (better) {
          best = d;
          best_a = a;
          best_b = b;
        }
      }
    }

    const int32_t left = active[best_a];
    const int32_t right = active[best_b];
    Merge m;
    m.left = std::min(left, right);
    m.right = std::max(left, right);
    m.height = best;
    merges.push_back(m);

    const int32_t new_id = next_id++;
    for (int32_t other : active) {
      if (other == left || other == right) {
        continue;
      }
      const double d = std::max(at(other, left), at(other, right));
      at(new_id, other) = d;
      at(other, new_id) = d;
    }

    if (best_a > best_b) {
      std::swap(best_a, best_b);
    }
    active.erase(active.begin() + static_cast<std::ptrdiff_t>(best_b));
    active.erase(active.begin() + static_cast<std::ptrdiff_t>(best_a));
    active.push_back(new_id);
  }

  return merges;
}

std::vector<int32_t> AssignLabelsFromParents(
    const std::vector<int32_t>& parent, int32_t n) {
  auto find = [&](int32_t x) {
    while (parent[static_cast<size_t>(x)] != x) {
      x = parent[static_cast<size_t>(x)];
    }
    return x;
  };

  std::vector<int32_t> root_of(static_cast<size_t>(n));
  for (int32_t i = 0; i < n; ++i) {
    root_of[static_cast<size_t>(i)] = find(i);
  }
  std::vector<int32_t> unique = root_of;
  std::sort(unique.begin(), unique.end());
  unique.erase(std::unique(unique.begin(), unique.end()), unique.end());

  std::vector<int32_t> labels(static_cast<size_t>(n));
  for (int32_t i = 0; i < n; ++i) {
    const auto it = std::lower_bound(unique.begin(), unique.end(),
                                     root_of[static_cast<size_t>(i)]);
    labels[static_cast<size_t>(i)] =
        static_cast<int32_t>(it - unique.begin());
  }
  return labels;
}

std::vector<int32_t> CutreeK(const std::vector<Merge>& merges, int32_t n,
                             int32_t k) {
  if (n <= 0) {
    return {};
  }
  if (n == 1) {
    return {0};
  }
  k = std::max(1, std::min(k, n));

  std::vector<int32_t> parent(static_cast<size_t>(2 * n));
  std::iota(parent.begin(), parent.end(), 0);

  auto find = [&](int32_t x) {
    while (parent[static_cast<size_t>(x)] != x) {
      parent[static_cast<size_t>(x)] =
          parent[static_cast<size_t>(parent[static_cast<size_t>(x)])];
      x = parent[static_cast<size_t>(x)];
    }
    return x;
  };

  const int32_t merges_to_apply = n - k;
  for (int32_t i = 0;
       i < merges_to_apply && i < static_cast<int32_t>(merges.size()); ++i) {
    const int32_t a = find(merges[static_cast<size_t>(i)].left);
    const int32_t b = find(merges[static_cast<size_t>(i)].right);
    const int32_t new_id = n + i;
    parent[static_cast<size_t>(a)] = new_id;
    parent[static_cast<size_t>(b)] = new_id;
    parent[static_cast<size_t>(new_id)] = new_id;
  }

  return AssignLabelsFromParents(parent, n);
}

std::vector<int32_t> CutreeCdist(const std::vector<Merge>& merges, int32_t n,
                                 double threshold) {
  if (n <= 0) {
    return {};
  }
  if (n == 1) {
    return {0};
  }

  std::vector<int32_t> parent(static_cast<size_t>(2 * n));
  std::iota(parent.begin(), parent.end(), 0);

  auto find = [&](int32_t x) {
    while (parent[static_cast<size_t>(x)] != x) {
      parent[static_cast<size_t>(x)] =
          parent[static_cast<size_t>(parent[static_cast<size_t>(x)])];
      x = parent[static_cast<size_t>(x)];
    }
    return x;
  };

  for (int32_t i = 0; i < static_cast<int32_t>(merges.size()); ++i) {
    if (merges[static_cast<size_t>(i)].height > threshold) {
      break;
    }
    const int32_t a = find(merges[static_cast<size_t>(i)].left);
    const int32_t b = find(merges[static_cast<size_t>(i)].right);
    const int32_t new_id = n + i;
    parent[static_cast<size_t>(a)] = new_id;
    parent[static_cast<size_t>(b)] = new_id;
    parent[static_cast<size_t>(new_id)] = new_id;
  }

  return AssignLabelsFromParents(parent, n);
}

}  // namespace

AgglomerativeClusterer::AgglomerativeClusterer(ClusteringConfig config)
    : config_(config) {}

void AgglomerativeClusterer::setConfig(ClusteringConfig config) {
  config_ = config;
}

std::vector<int32_t> AgglomerativeClusterer::Cluster(float* features,
                                                     int32_t num_rows,
                                                     int32_t num_cols) const {
  if (features == nullptr || num_rows <= 0 || num_cols <= 0) {
    return {};
  }
  if (num_rows == 1) {
    return {0};
  }

  NormalizeRows(features, num_rows, num_cols);

  const size_t condensed_n =
      static_cast<size_t>(num_rows) * static_cast<size_t>(num_rows - 1) / 2;
  std::vector<double> dist(condensed_n);
  for (int32_t i = 0; i < num_rows; ++i) {
    const float* ri =
        features + static_cast<size_t>(i) * static_cast<size_t>(num_cols);
    for (int32_t j = i + 1; j < num_rows; ++j) {
      const float* rj =
          features + static_cast<size_t>(j) * static_cast<size_t>(num_cols);
      dist[CondensedIndex(num_rows, i, j)] =
          CosineDissimilarity(ri, rj, num_cols);
    }
  }

  auto merges = LinkageComplete(dist, num_rows);
  if (config_.num_clusters > 0) {
    return CutreeK(merges, num_rows, config_.num_clusters);
  }
  return CutreeCdist(merges, num_rows, static_cast<double>(config_.threshold));
}

}  // namespace sherpaonnx::diarization
