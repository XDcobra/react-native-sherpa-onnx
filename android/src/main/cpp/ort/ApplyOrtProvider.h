/**
 * Attach an ORT execution provider. Missing or unusable EP logs and stays on
 * CPU. Does not throw.
 */
#pragma once

#include <string_view>

struct OrtApi;
struct OrtSessionOptions;

#if defined(__has_include)
#if __has_include(<onnxruntime_cxx_api.h>)
#include <onnxruntime_cxx_api.h>
#define SHERPA_ONNX_APPLY_ORT_PROVIDER_CXX 1
#elif __has_include(<onnxruntime/core/session/onnxruntime_cxx_api.h>)
#include <onnxruntime/core/session/onnxruntime_cxx_api.h>
#define SHERPA_ONNX_APPLY_ORT_PROVIDER_CXX 1
#endif
#endif

namespace sherpa_onnx {

/** C-API entry used by CTC alignment. `api` / `options` null is a no-op. */
void ApplyOrtProvider(const OrtApi* api, OrtSessionOptions* options,
                      std::string_view provider);

#if defined(SHERPA_ONNX_APPLY_ORT_PROVIDER_CXX)
inline void ApplyOrtProvider(Ort::SessionOptions& options, std::string_view provider) {
  ApplyOrtProvider(&Ort::GetApi(), static_cast<OrtSessionOptions*>(options), provider);
}
#endif

}  // namespace sherpa_onnx
