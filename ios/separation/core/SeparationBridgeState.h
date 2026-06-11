#pragma once

#ifdef __cplusplus

namespace sherpaonnx {
class SeparationWrapper;
}  // namespace sherpaonnx

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace sherpaonnx {
namespace separation {
namespace bridge {

struct SeparationInstanceState {
  std::unique_ptr<sherpaonnx::SeparationWrapper> wrapper;
};

extern std::unordered_map<std::string, std::unique_ptr<SeparationInstanceState>>
    g_separation_instances;
extern std::mutex g_separation_mutex;

}  // namespace bridge
}  // namespace separation
}  // namespace sherpaonnx

#endif
