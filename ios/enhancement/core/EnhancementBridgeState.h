#pragma once

#ifdef __cplusplus

namespace sherpaonnx {
class EnhancementWrapper;
class OnlineEnhancementWrapper;
}  // namespace sherpaonnx

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace sherpaonnx {
namespace enhancement {
namespace bridge {

struct EnhancementInstanceState {
  std::unique_ptr<sherpaonnx::EnhancementWrapper> wrapper;
  std::string activeLivePipelineId;
};

struct OnlineEnhancementInstanceState {
  std::shared_ptr<sherpaonnx::OnlineEnhancementWrapper> wrapper;
};

extern std::unordered_map<std::string, std::unique_ptr<EnhancementInstanceState>> g_enhancement_instances;
extern std::unordered_map<std::string, std::unique_ptr<OnlineEnhancementInstanceState>> g_online_enhancement_instances;
extern std::mutex g_enhancement_mutex;

}  // namespace bridge
}  // namespace enhancement
}  // namespace sherpaonnx

#endif