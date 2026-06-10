#pragma once

#ifdef __cplusplus

#include <cstdint>
#include <optional>
#include <string>

// Phase 1a: cross-domain linkage contract types (type layer only).

enum class PaSegmentLinkType : uint8_t {
  Alignment,
  Proportional,
  VadAssisted,
  Sequential,
  TtsProduced,
  SttProduced,
  UserDefined,
};

struct PaSegmentLink {
  std::string linkId;
  std::string textSegmentId;
  std::string speechSegmentId;
  PaSegmentLinkType linkType = PaSegmentLinkType::UserDefined;
  std::optional<float> confidence;
  std::optional<std::string> metaJson;
};

struct PaSegmentLinkMapRef {
  std::string linkMapId;
};

struct PaSegmentLinkMapInfo {
  std::string linkMapId;
  int32_t linkCount = 0;
  std::optional<std::string> textBufferId;
  std::optional<std::string> audioBufferId;
};

#endif // __cplusplus

