#ifndef SHERPA_ONNX_DIARIZATION_TYPES_H
#define SHERPA_ONNX_DIARIZATION_TYPES_H

#include "speaker-embedding-types.h"

#include <cstdint>
#include <string>
#include <vector>

namespace sherpaonnx::diarization {

inline constexpr const char* kErrNotInitialized = "DIARIZATION_NOT_INITIALIZED";
inline constexpr const char* kErrInvalidArgument = "DIARIZATION_INVALID_ARGUMENT";
inline constexpr const char* kErrModelLoad = "DIARIZATION_MODEL_LOAD_ERROR";
inline constexpr const char* kErrMetadata = "DIARIZATION_METADATA_ERROR";
inline constexpr const char* kErrInference = "DIARIZATION_INFERENCE_ERROR";
inline constexpr const char* kErrEmbedding = "DIARIZATION_EMBEDDING_ERROR";
inline constexpr const char* kErrCancelled = "DIARIZATION_CANCELLED";
inline constexpr const char* kErrNoSpeakers = "DIARIZATION_NO_SPEAKERS";
inline constexpr const char* kErrInternal = "DIARIZATION_INTERNAL_ERROR";

using SampleRange = ::sherpaonnx::speaker_embedding::SampleRange;
using Status = ::sherpaonnx::speaker_embedding::Status;

struct DiarizationSegment {
  float start = 0.f;
  float end = 0.f;
  int32_t speaker = 0;
};

struct PyannoteMeta {
  int32_t sample_rate = 0;
  int32_t window_size = 0;
  int32_t window_shift = 0;
  int32_t receptive_field_size = 0;
  int32_t receptive_field_shift = 0;
  int32_t num_speakers = 0;
  int32_t powerset_max_classes = 0;
  int32_t num_classes = 0;
};

/** Row-major int8 multi-label matrix: rows × cols. */
struct Int8Matrix {
  int32_t rows = 0;
  int32_t cols = 0;
  std::vector<int8_t> data;

  void resize(int32_t r, int32_t c, int8_t fill = 0) {
    rows = r;
    cols = c;
    data.assign(static_cast<size_t>(r) * static_cast<size_t>(c), fill);
  }

  int8_t& at(int32_t r, int32_t c) {
    return data[static_cast<size_t>(r) * static_cast<size_t>(cols) +
                static_cast<size_t>(c)];
  }

  int8_t at(int32_t r, int32_t c) const {
    return data[static_cast<size_t>(r) * static_cast<size_t>(cols) +
                static_cast<size_t>(c)];
  }
};

struct FloatMatrix {
  int32_t rows = 0;
  int32_t cols = 0;
  std::vector<float> data;

  void resize(int32_t r, int32_t c, float fill = 0.f) {
    rows = r;
    cols = c;
    data.assign(static_cast<size_t>(r) * static_cast<size_t>(c), fill);
  }

  float& at(int32_t r, int32_t c) {
    return data[static_cast<size_t>(r) * static_cast<size_t>(cols) +
                static_cast<size_t>(c)];
  }

  float at(int32_t r, int32_t c) const {
    return data[static_cast<size_t>(r) * static_cast<size_t>(cols) +
                static_cast<size_t>(c)];
  }

  float* rowPtr(int32_t r) {
    return data.data() + static_cast<size_t>(r) * static_cast<size_t>(cols);
  }

  const float* rowPtr(int32_t r) const {
    return data.data() + static_cast<size_t>(r) * static_cast<size_t>(cols);
  }
};

struct ChunkSpeakerKey {
  int32_t chunk = 0;
  int32_t local_speaker = 0;

  bool operator==(const ChunkSpeakerKey& o) const {
    return chunk == o.chunk && local_speaker == o.local_speaker;
  }
};

}  // namespace sherpaonnx::diarization

#endif  // SHERPA_ONNX_DIARIZATION_TYPES_H
