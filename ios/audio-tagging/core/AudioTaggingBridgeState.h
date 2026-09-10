#pragma once

#ifdef __cplusplus

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

#if __has_include(<sherpa-onnx/c-api/c-api.h>)
#include <sherpa-onnx/c-api/c-api.h>
#elif __has_include("sherpa-onnx/c-api/c-api.h")
#include "sherpa-onnx/c-api/c-api.h"
#else
#include "../../../third_party/sherpa-onnx/sherpa-onnx/c-api/c-api.h"
#endif

namespace sherpaonnx {
namespace audio_tagging {
namespace bridge {

struct AudioTaggingInstanceState {
  const SherpaOnnxAudioTagging *handle = nullptr;
  int32_t defaultTopK = 5;
  int32_t numThreads = 1;
  std::string provider = "cpu";
  std::string modelType;

  // Keep path strings alive for the lifetime of the C-API handle (c_str pointers).
  std::string modelPath;
  std::string labelsPath;
  std::string providerStorage;

  ~AudioTaggingInstanceState() {
    if (handle != nullptr) {
      SherpaOnnxDestroyAudioTagging(handle);
      handle = nullptr;
    }
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
