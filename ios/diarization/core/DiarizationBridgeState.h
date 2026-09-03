#pragma once

#ifdef __cplusplus

namespace sherpaonnx {
class DiarizationWrapper;
}  // namespace sherpaonnx

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace sherpaonnx {
namespace diarization {
namespace bridge {

extern std::unordered_map<std::string, std::unique_ptr<sherpaonnx::DiarizationWrapper>>
    g_diarization_instances;
extern std::mutex g_diarization_mutex;

}  // namespace bridge
}  // namespace diarization
}  // namespace sherpaonnx

#endif
