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

extern std::unordered_map<std::string,
                          std::shared_ptr<sherpaonnx::SpeakerEmbeddingExtractorWrapper>>
    g_speaker_embedding_extractors;
extern std::unordered_map<std::string,
                          std::shared_ptr<sherpaonnx::SpeakerEmbeddingManagerWrapper>>
    g_speaker_embedding_managers;
extern std::mutex g_speaker_embedding_mutex;

/** Copy a strong ref under the map lock; caller uses it outside the lock. */
std::shared_ptr<sherpaonnx::SpeakerEmbeddingExtractorWrapper> LookupExtractor(
    const std::string& id);
std::shared_ptr<sherpaonnx::SpeakerEmbeddingManagerWrapper> LookupManager(
    const std::string& id);

}  // namespace bridge
}  // namespace speaker_embedding
}  // namespace sherpaonnx

#endif
