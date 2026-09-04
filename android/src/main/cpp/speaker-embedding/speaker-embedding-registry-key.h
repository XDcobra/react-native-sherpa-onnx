#ifndef SHERPA_ONNX_SPEAKER_EMBEDDING_REGISTRY_KEY_H
#define SHERPA_ONNX_SPEAKER_EMBEDDING_REGISTRY_KEY_H

#include "speaker-embedding-runner.h"

#include <algorithm>
#include <functional>
#include <string>

namespace sherpaonnx::speaker_embedding {

/**
 * Process-wide extractor cache key. Host-testable without sherpa C-API.
 * Must stay in sync with Acquire() normalization in speaker-embedding-runner.cpp.
 */
struct RegistryKey {
  std::string model_path;
  std::string provider;
  int32_t num_threads = 1;
  bool debug = false;

  bool operator==(const RegistryKey& o) const {
    return num_threads == o.num_threads && debug == o.debug &&
           model_path == o.model_path && provider == o.provider;
  }
};

struct RegistryKeyHash {
  size_t operator()(const RegistryKey& k) const {
    size_t h = std::hash<std::string>{}(k.model_path);
    h ^= std::hash<std::string>{}(k.provider) + 0x9e3779b9 + (h << 6) +
         (h >> 2);
    h ^= std::hash<int32_t>{}(k.num_threads) + 0x9e3779b9 + (h << 6) +
         (h >> 2);
    h ^= std::hash<bool>{}(k.debug) + 0x9e3779b9 + (h << 6) + (h >> 2);
    return h;
  }
};

inline RegistryKey MakeRegistryKey(const EmbeddingRunnerOptions& options) {
  RegistryKey key;
  key.model_path = options.model_path;
  key.provider = options.provider.empty() ? "cpu" : options.provider;
  key.num_threads = std::max(1, options.num_threads);
  key.debug = options.debug;
  return key;
}

}  // namespace sherpaonnx::speaker_embedding

#endif  // SHERPA_ONNX_SPEAKER_EMBEDDING_REGISTRY_KEY_H
