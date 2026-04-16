/**
 * sherpa-onnx-ort-guard-utils.h
 *
 * Shared ORT (ONNX Runtime) utilities for online-compatibility guard implementations.
 * Used by both enhancement and STT online guards to safely inspect model metadata
 * and tensor shapes without triggering upstream SHERPA_ONNX_EXIT(-1).
 *
 * All functions are guarded by SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT; when ORT headers
 * are not available the translation unit compiles to an empty object.
 */
#ifndef SHERPA_ONNX_ORT_GUARD_UTILS_H
#define SHERPA_ONNX_ORT_GUARD_UTILS_H

#include <cstdint>
#include <string>
#include <vector>

// ── Compile-time ORT availability ──────────────────────────────────────

#if !defined(SHERPA_ONNX_MODEL_DETECT_DISABLE_ORT_GUARD)
#if defined(__has_include)
#if __has_include("onnxruntime_cxx_api.h")
#define SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT 1
#include "onnxruntime_cxx_api.h"  // NOLINT
#else
#define SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT 0
#endif
#else
#define SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT 0
#endif
#else
#define SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT 0
#endif

namespace sherpaonnx::ort_guard_utils {

// ── Path helpers (always available) ────────────────────────────────────

/** Returns true if \p path looks like an absolute filesystem path. */
bool LooksLikeAbsolutePath(const std::string& path);

// ── Parsing helpers (always available) ─────────────────────────────────

void TrimAsciiInPlace(std::string* text);
bool ParseInt32Strict(const std::string& text, int32_t* out);
bool ParseInt64Strict(const std::string& text, int64_t* out);
bool ParseFloatStrict(const std::string& text, float* out);
bool ParseCsvInt32(const std::string& text, std::vector<int32_t>* out);
bool ParseCsvInt64(const std::string& text, std::vector<int64_t>* out);
bool ParseCsvFloat(const std::string& text, std::vector<float>* out);
std::string ShapeToString(const std::vector<int64_t>& shape);

// ── ORT metadata / session helpers (require ORT) ──────────────────────

#if SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT

std::string LookupMetadataValue(
    const Ort::ModelMetadata& metaData,
    const char* key,
    OrtAllocator* allocator
);

bool ReadRequiredMetadataString(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    std::string* out,
    std::string* error
);

bool ReadRequiredMetadataInt32(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    int32_t* out,
    std::string* error
);

bool ReadOptionalMetadataInt32(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    int32_t defaultValue,
    int32_t* out,
    std::string* error
);

bool ReadOptionalMetadataString(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    std::string* out
);

bool ReadRequiredMetadataInt32Vec(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    std::vector<int32_t>* out,
    std::string* error
);

bool ReadRequiredMetadataInt64Vec(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    std::vector<int64_t>* out,
    std::string* error
);

bool ReadRequiredMetadataFloatVec(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    std::vector<float>* out,
    std::string* error
);

bool ReadTensorShape(
    const Ort::Session& session,
    bool input,
    size_t index,
    std::vector<int64_t>* out,
    std::string* error
);

Ort::Session CreateOrtSession(
    Ort::Env& env,
    const std::string& modelPath,
    const Ort::SessionOptions& opts
);

#endif  // SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT

}  // namespace sherpaonnx::ort_guard_utils

#endif  // SHERPA_ONNX_ORT_GUARD_UTILS_H
