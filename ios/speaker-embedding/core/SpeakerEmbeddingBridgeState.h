#pragma once

#ifdef __cplusplus

namespace sherpaonnx {
class SpeakerEmbeddingExtractorWrapper;
class SpeakerEmbeddingManagerWrapper;
}  // namespace sherpaonnx

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace sherpaonnx {
namespace speaker_embedding {
namespace bridge {

struct SpeakerEmbeddingExtractorState {
  std::unique_ptr<sherpaonnx::SpeakerEmbeddingExtractorWrapper> wrapper;
};

struct SpeakerEmbeddingManagerState {
  std::unique_ptr<sherpaonnx::SpeakerEmbeddingManagerWrapper> wrapper;
};

extern std::unordered_map<std::string, std::unique_ptr<SpeakerEmbeddingExtractorState>>
    g_speaker_embedding_extractors;
extern std::unordered_map<std::string, std::unique_ptr<SpeakerEmbeddingManagerState>>
    g_speaker_embedding_managers;
extern std::mutex g_speaker_embedding_mutex;

}  // namespace bridge
}  // namespace speaker_embedding
}  // namespace sherpaonnx

#endif
