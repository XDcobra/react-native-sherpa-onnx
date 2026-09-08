#ifndef SHERPA_ONNX_SPEAKER_EMBEDDING_MANAGER_H
#define SHERPA_ONNX_SPEAKER_EMBEDDING_MANAGER_H

#include "speaker-embedding-types.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace sherpaonnx::speaker_embedding {

/**
 * Named-speaker enrollment store over the sherpa-onnx C API.
 * Not shared across SID instances — each managerId owns one.
 */
class SpeakerEmbeddingManagerCore {
 public:
  SpeakerEmbeddingManagerCore();
  ~SpeakerEmbeddingManagerCore();

  SpeakerEmbeddingManagerCore(const SpeakerEmbeddingManagerCore&) = delete;
  SpeakerEmbeddingManagerCore& operator=(const SpeakerEmbeddingManagerCore&) =
      delete;

  Status Create(int32_t dim);
  void Release();

  bool isReady() const;
  int32_t dim() const;

  Status Add(const std::string& name, const std::vector<float>& flattened,
             int32_t count);
  Status Remove(const std::string& name);
  /** Empty string = no match. */
  std::string Search(const std::vector<float>& embedding, float threshold) const;
  bool Verify(const std::string& name, const std::vector<float>& embedding,
              float threshold) const;
  bool Contains(const std::string& name) const;
  int32_t NumSpeakers() const;
  std::vector<std::string> AllSpeakers() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace sherpaonnx::speaker_embedding

#endif  // SHERPA_ONNX_SPEAKER_EMBEDDING_MANAGER_H
