#pragma once

#ifdef __cplusplus

#include "sherpa-onnx-slid-wrapper.h"

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace sherpaonnx {
namespace language_id {
namespace bridge {

struct LanguageIdInstanceState {
  std::shared_ptr<sherpaonnx::SpokenLanguageIdWrapper> wrapper;
  int32_t numThreads = 1;
  std::string provider = "cpu";

  bool isReady() const {
    return wrapper != nullptr && wrapper->isInitialized();
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
