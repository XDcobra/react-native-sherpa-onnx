#include "SpeakerEmbeddingBridgeState.h"
#include "../native/sherpa-onnx-speaker-embedding-wrapper.h"

namespace sherpaonnx {
namespace speaker_embedding {
namespace bridge {

std::unordered_map<std::string, std::unique_ptr<SpeakerEmbeddingExtractorState>>
    g_speaker_embedding_extractors;
std::unordered_map<std::string, std::unique_ptr<SpeakerEmbeddingManagerState>>
    g_speaker_embedding_managers;
std::mutex g_speaker_embedding_mutex;

}  // namespace bridge
}  // namespace speaker_embedding
}  // namespace sherpaonnx
