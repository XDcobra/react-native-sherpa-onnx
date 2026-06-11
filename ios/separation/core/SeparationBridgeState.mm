#include "SeparationBridgeState.h"
#include "../sherpa-onnx-separation-wrapper.h"

namespace sherpaonnx {
namespace separation {
namespace bridge {

std::unordered_map<std::string, std::unique_ptr<SeparationInstanceState>>
    g_separation_instances;
std::mutex g_separation_mutex;

}  // namespace bridge
}  // namespace separation
}  // namespace sherpaonnx
