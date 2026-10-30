/**
 * Shared OCR ORT helpers. Not a backend base — families still own Load/Recognize.
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace Ort {
class Env;
class Session;
class SessionOptions;
class MemoryInfo;
class Value;
}  // namespace Ort

namespace sherpa_onnx {
namespace ocr {

void OcrRequireRegularFile(const std::string& path, const char* who);

int32_t OcrArgmax(const float* row, int n);

/** VLM sessions: CPU EP, no arena / mem-pattern / prepacking (lower peak RSS). */
Ort::SessionOptions OcrMakeVlmSessionOptions(int num_threads,
                                             std::string_view provider);

/**
 * Create an ORT session via the C API (status object, no C++ throw).
 * Ort::Session's path ctor throws Ort::Exception from libonnxruntime; on Android
 * that unwind is hijacked by Pdfium's _Unwind_Resume and becomes SIGBUS.
 * Failures throw std::runtime_error from this DSO so JNI/iOS can map them to
 * OCR_INTERNAL_ERROR. No silent CPU retry.
 */
std::unique_ptr<Ort::Session> OcrCreateOrtSession(
    Ort::Env& env, const Ort::SessionOptions& options, const std::string& path,
    const char* label, std::string_view provider);

/** Empty KV cache tensors: [1, kv_heads, 0, head_dim] × (layers * 2). */
std::vector<Ort::Value> OcrEmptyKvCache(const Ort::MemoryInfo& mem, int layers,
                                        int kv_heads, int head_dim);

}  // namespace ocr
}  // namespace sherpa_onnx
