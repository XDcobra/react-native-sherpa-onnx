#ifndef SHERPA_ONNX_SPEAKER_EMBEDDING_TYPES_H
#define SHERPA_ONNX_SPEAKER_EMBEDDING_TYPES_H

#include <cstdint>
#include <string>

namespace sherpaonnx::speaker_embedding {

inline constexpr const char* kErrNotInitialized =
    "SPEAKER_EMBEDDING_NOT_INITIALIZED";
inline constexpr const char* kErrInvalidArgument =
    "SPEAKER_EMBEDDING_INVALID_ARGUMENT";
inline constexpr const char* kErrInit = "SPEAKER_EMBEDDING_INIT_ERROR";
inline constexpr const char* kErrCompute = "SPEAKER_EMBEDDING_COMPUTE_ERROR";
inline constexpr const char* kErrManager = "SPEAKER_EMBEDDING_MANAGER_ERROR";
inline constexpr const char* kErrInternal = "SPEAKER_EMBEDDING_INTERNAL_ERROR";

struct SampleRange {
  int32_t start = 0;
  int32_t end = 0;
};

struct Status {
  bool ok = true;
  std::string code;
  std::string message;

  static Status Ok() { return {}; }

  static Status Fail(const char* c, const std::string& msg) {
    Status s;
    s.ok = false;
    s.code = c != nullptr ? c : kErrInternal;
    s.message = msg;
    return s;
  }
};

}  // namespace sherpaonnx::speaker_embedding

#endif  // SHERPA_ONNX_SPEAKER_EMBEDDING_TYPES_H
