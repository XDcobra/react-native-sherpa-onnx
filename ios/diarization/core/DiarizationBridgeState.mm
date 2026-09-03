#include "DiarizationBridgeState.h"
#include "sherpa-onnx-diarization-wrapper.h"

namespace sherpaonnx {
namespace diarization {
namespace bridge {

std::unordered_map<std::string, std::unique_ptr<sherpaonnx::DiarizationWrapper>>
    g_diarization_instances;
std::mutex g_diarization_mutex;

}  // namespace bridge
}  // namespace diarization
}  // namespace sherpaonnx
