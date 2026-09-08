#include "LanguageIdBridgeState.h"

namespace sherpaonnx {
namespace language_id {
namespace bridge {

std::unordered_map<std::string, std::shared_ptr<LanguageIdInstanceState>>
    g_language_id_instances;
std::mutex g_language_id_mutex;

std::shared_ptr<LanguageIdInstanceState> LookupLanguageId(const std::string &id) {
  std::lock_guard<std::mutex> lock(g_language_id_mutex);
  auto it = g_language_id_instances.find(id);
  if (it != g_language_id_instances.end()) {
    return it->second;
  }
  return nullptr;
}

void RemoveLanguageId(const std::string &id) {
  std::shared_ptr<LanguageIdInstanceState> removed;
  {
    std::lock_guard<std::mutex> lock(g_language_id_mutex);
    auto it = g_language_id_instances.find(id);
    if (it != g_language_id_instances.end()) {
      removed = std::move(it->second);
      g_language_id_instances.erase(it);
    }
  }
  // LanguageIdInstanceState destructor destroys handle
}

}  // namespace bridge
}  // namespace language_id
}  // namespace sherpaonnx
