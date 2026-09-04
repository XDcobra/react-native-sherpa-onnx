#include "SpeakerEmbeddingBridgeState.h"
#include "sherpa-onnx-speaker-embedding-wrapper.h"

namespace sherpaonnx {
namespace speaker_embedding {
namespace bridge {

std::unordered_map<std::string,
                   std::shared_ptr<sherpaonnx::SpeakerEmbeddingExtractorWrapper>>
    g_speaker_embedding_extractors;
std::unordered_map<std::string,
                   std::shared_ptr<sherpaonnx::SpeakerEmbeddingManagerWrapper>>
    g_speaker_embedding_managers;
std::mutex g_speaker_embedding_mutex;

std::shared_ptr<sherpaonnx::SpeakerEmbeddingExtractorWrapper> LookupExtractor(
    const std::string& id) {
  std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
  auto it = g_speaker_embedding_extractors.find(id);
  if (it == g_speaker_embedding_extractors.end() || !it->second) return nullptr;
  return it->second;
}

std::shared_ptr<sherpaonnx::SpeakerEmbeddingManagerWrapper> LookupManager(
    const std::string& id) {
  std::lock_guard<std::mutex> lock(g_speaker_embedding_mutex);
  auto it = g_speaker_embedding_managers.find(id);
  if (it == g_speaker_embedding_managers.end() || !it->second) return nullptr;
  return it->second;
}

}  // namespace bridge
}  // namespace speaker_embedding
}  // namespace sherpaonnx
