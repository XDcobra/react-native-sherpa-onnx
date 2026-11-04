#pragma once

#ifdef __cplusplus

#include "sherpa-onnx-punct-engine-wrapper.h"

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace sherpaonnx {
namespace punctuation {
namespace bridge {

struct OfflinePunctuationInstanceState {
  std::shared_ptr<sherpaonnx::OfflinePunctuationWrapper> wrapper;

  bool isReady() const {
    return wrapper != nullptr && wrapper->isInitialized();
  }
};

struct OnlinePunctuationInstanceState {
  std::shared_ptr<sherpaonnx::OnlinePunctuationWrapper> wrapper;

  bool isReady() const {
    return wrapper != nullptr && wrapper->isInitialized();
  }
};

extern std::unordered_map<std::string, std::shared_ptr<OfflinePunctuationInstanceState>>
    g_punct_offline_instances;
extern std::mutex g_punct_offline_mutex;

extern std::unordered_map<std::string, std::shared_ptr<OnlinePunctuationInstanceState>>
    g_punct_online_instances;
extern std::mutex g_punct_online_mutex;

std::shared_ptr<OfflinePunctuationInstanceState> LookupOfflinePunctuation(
    const std::string &id);
void RemoveOfflinePunctuation(const std::string &id);

std::shared_ptr<OnlinePunctuationInstanceState> LookupOnlinePunctuation(
    const std::string &id);
void RemoveOnlinePunctuation(const std::string &id);

}  // namespace bridge
}  // namespace punctuation
}  // namespace sherpaonnx

#endif
