#include "AudioTaggingBridgeState.h"

namespace sherpaonnx {
namespace audio_tagging {
namespace bridge {

std::unordered_map<std::string, std::shared_ptr<AudioTaggingInstanceState>>
    g_audio_tagging_instances;
std::mutex g_audio_tagging_mutex;

std::shared_ptr<AudioTaggingInstanceState> LookupAudioTagging(const std::string &id) {
  std::lock_guard<std::mutex> lock(g_audio_tagging_mutex);
  auto it = g_audio_tagging_instances.find(id);
  if (it != g_audio_tagging_instances.end()) {
    return it->second;
  }
  return nullptr;
}

void RemoveAudioTagging(const std::string &id) {
  std::shared_ptr<AudioTaggingInstanceState> removed;
  {
    std::lock_guard<std::mutex> lock(g_audio_tagging_mutex);
    auto it = g_audio_tagging_instances.find(id);
    if (it != g_audio_tagging_instances.end()) {
      removed = std::move(it->second);
      g_audio_tagging_instances.erase(it);
    }
  }
  // Destructor destroys handle
}

}  // namespace bridge
}  // namespace audio_tagging
}  // namespace sherpaonnx
