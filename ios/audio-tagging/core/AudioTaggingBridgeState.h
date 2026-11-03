#pragma once

#ifdef __cplusplus

#include "sherpa-onnx-audio-tagging-wrapper.h"

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace sherpaonnx {
namespace audio_tagging {
namespace bridge {

struct AudioTaggingInstanceState {
  std::shared_ptr<sherpaonnx::AudioTaggingWrapper> wrapper;
  int32_t defaultTopK = 5;
  int32_t numThreads = 1;
  std::string provider = "cpu";
  std::string modelType;
  std::string activeLivePipelineId;

  bool isReady() const {
    return wrapper != nullptr && wrapper->isInitialized();
  }
};

extern std::unordered_map<std::string, std::shared_ptr<AudioTaggingInstanceState>>
    g_audio_tagging_instances;
extern std::mutex g_audio_tagging_mutex;

std::shared_ptr<AudioTaggingInstanceState> LookupAudioTagging(const std::string &id);
void RemoveAudioTagging(const std::string &id);

}  // namespace bridge
}  // namespace audio_tagging
}  // namespace sherpaonnx

#endif
