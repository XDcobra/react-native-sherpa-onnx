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

extern std::unordered_map<std::string, std::shared_ptr<sherpaonnx::DiarizationWrapper>>
    g_diarization_instances;
extern std::mutex g_diarization_mutex;

/** Copy a strong ref under the map lock; caller uses it outside the lock. */
std::shared_ptr<sherpaonnx::DiarizationWrapper> LookupDiarization(
    const std::string& id);

}  // namespace bridge
}  // namespace diarization
}  // namespace sherpaonnx

#endif
