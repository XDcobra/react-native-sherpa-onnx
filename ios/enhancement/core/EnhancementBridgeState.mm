#include "EnhancementBridgeState.h"
#include "../sherpa-onnx-enhancement-wrapper.h"

namespace sherpaonnx {
namespace enhancement {
namespace bridge {

std::unordered_map<std::string, std::unique_ptr<EnhancementInstanceState>> g_enhancement_instances;
std::unordered_map<std::string, std::unique_ptr<OnlineEnhancementInstanceState>> g_online_enhancement_instances;
std::mutex g_enhancement_mutex;

}  // namespace bridge
}  // namespace enhancement
}  // namespace sherpaonnx