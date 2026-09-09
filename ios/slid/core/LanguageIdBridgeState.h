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
namespace language_id {
namespace bridge {

struct LanguageIdInstanceState {
  const SherpaOnnxSpokenLanguageIdentification *handle = nullptr;
  int32_t numThreads = 1;
  std::string provider = "cpu";

  ~LanguageIdInstanceState() {
    if (handle != nullptr) {
      SherpaOnnxDestroySpokenLanguageIdentification(handle);
      handle = nullptr;
    }
  }
};

extern std::unordered_map<std::string, std::shared_ptr<LanguageIdInstanceState>>
    g_language_id_instances;
extern std::mutex g_language_id_mutex;

std::shared_ptr<LanguageIdInstanceState> LookupLanguageId(const std::string &id);
void RemoveLanguageId(const std::string &id);

}  // namespace bridge
}  // namespace language_id
}  // namespace sherpaonnx

#endif
