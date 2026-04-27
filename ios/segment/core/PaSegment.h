#pragma once

#ifdef __cplusplus

#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

// Phase 1a: canonical segment contract types (type layer only).

enum class PaSegmentDomain : uint8_t {
  Text,
  Speech,
};

enum class PaSegmentReason : uint8_t {
  Endpoint,
  Punctuation,
  LengthLimit,
  VadBoundary,
  EnergySilence,
  ManualCommit,
  Finalize,
  PolicyCheckpoint,
};

enum class PaSegmentSource : uint8_t {
  SegmentationEngine,
  Manual,
  External,
};

struct PaSegmentBase {
  std::string segmentId;
  PaSegmentDomain domain = PaSegmentDomain::Text;
  int64_t startOffset = 0;
  int64_t endOffset = 0;
  PaSegmentReason reason = PaSegmentReason::ManualCommit;
  PaSegmentSource source = PaSegmentSource::Manual;
  int64_t createdAtMs = 0;
  int32_t segmentIndex = 0;
};

struct PaVadInfo {
  std::optional<std::string> engine;
  std::optional<std::string> decision;
  std::optional<float> score;
};

struct PaTextSegment : PaSegmentBase {
  std::string text;
  int32_t utf16Length = 0;
  std::optional<std::vector<std::string>> tokens;
  std::optional<std::vector<float>> timestamps;
  std::optional<std::string> lang;
  std::optional<std::string> metaJson;
};

struct PaSpeechSegment : PaSegmentBase {
  std::string sourceAudioBufferId;
  int32_t sampleRate = 0;
  float durationMs = 0.f;
  std::optional<float> confidence;
  std::optional<float> energy;
  std::optional<PaVadInfo> vadInfo;
  std::optional<std::string> metaJson;
};

using PaSegment = std::variant<PaTextSegment, PaSpeechSegment>;

#endif // __cplusplus

