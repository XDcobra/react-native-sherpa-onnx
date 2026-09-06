#include "DiarizationBridgeState.h"
#include "sherpa-onnx-diarization-wrapper.h"
#include "sherpa-onnx-streaming-diarization-wrapper.h"

namespace sherpaonnx {
namespace diarization {
namespace bridge {

std::unordered_map<std::string, std::shared_ptr<sherpaonnx::DiarizationWrapper>>
    g_diarization_instances;
std::mutex g_diarization_mutex;

std::unordered_map<std::string, std::shared_ptr<sherpaonnx::StreamingDiarizationWrapper>>
    g_streaming_diarization_instances;
std::mutex g_streaming_diarization_mutex;

std::shared_ptr<sherpaonnx::DiarizationWrapper> LookupDiarization(
    const std::string& id) {
  std::lock_guard<std::mutex> lock(g_diarization_mutex);
  auto it = g_diarization_instances.find(id);
  if (it == g_diarization_instances.end() || !it->second) return nullptr;
  return it->second;
}

std::shared_ptr<sherpaonnx::StreamingDiarizationWrapper> LookupStreamingDiarization(
    const std::string& id) {
  std::lock_guard<std::mutex> lock(g_streaming_diarization_mutex);
  auto it = g_streaming_diarization_instances.find(id);
  if (it == g_streaming_diarization_instances.end() || !it->second) return nullptr;
  return it->second;
}

}  // namespace bridge
}  // namespace diarization
}  // namespace sherpaonnx
