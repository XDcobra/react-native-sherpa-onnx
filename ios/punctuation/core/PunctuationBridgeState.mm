#include "PunctuationBridgeState.h"

namespace sherpaonnx {
namespace punctuation {
namespace bridge {

std::unordered_map<std::string, std::shared_ptr<OfflinePunctuationInstanceState>>
    g_punct_offline_instances;
std::mutex g_punct_offline_mutex;

std::unordered_map<std::string, std::shared_ptr<OnlinePunctuationInstanceState>>
    g_punct_online_instances;
std::mutex g_punct_online_mutex;

std::shared_ptr<OfflinePunctuationInstanceState> LookupOfflinePunctuation(
    const std::string &id) {
  std::lock_guard<std::mutex> lock(g_punct_offline_mutex);
  auto it = g_punct_offline_instances.find(id);
  if (it != g_punct_offline_instances.end()) {
    return it->second;
  }
  return nullptr;
}

void RemoveOfflinePunctuation(const std::string &id) {
  std::shared_ptr<OfflinePunctuationInstanceState> removed;
  {
    std::lock_guard<std::mutex> lock(g_punct_offline_mutex);
    auto it = g_punct_offline_instances.find(id);
    if (it != g_punct_offline_instances.end()) {
      removed = std::move(it->second);
      g_punct_offline_instances.erase(it);
    }
  }
}

std::shared_ptr<OnlinePunctuationInstanceState> LookupOnlinePunctuation(
    const std::string &id) {
  std::lock_guard<std::mutex> lock(g_punct_online_mutex);
  auto it = g_punct_online_instances.find(id);
  if (it != g_punct_online_instances.end()) {
    return it->second;
  }
  return nullptr;
}

void RemoveOnlinePunctuation(const std::string &id) {
  std::shared_ptr<OnlinePunctuationInstanceState> removed;
  {
    std::lock_guard<std::mutex> lock(g_punct_online_mutex);
    auto it = g_punct_online_instances.find(id);
    if (it != g_punct_online_instances.end()) {
      removed = std::move(it->second);
      g_punct_online_instances.erase(it);
    }
  }
}

}  // namespace bridge
}  // namespace punctuation
}  // namespace sherpaonnx
