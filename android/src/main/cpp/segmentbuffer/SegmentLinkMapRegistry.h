#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

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

bool slm_parse_link_type(const std::string &raw, PaSegmentLinkType *out);
const char *slm_link_type_raw(PaSegmentLinkType type);

bool slm_create(const std::string &textBufferIdOrEmpty, const std::string &audioBufferIdOrEmpty,
                std::string *linkMapIdOut, std::string *error = nullptr);
bool slm_add_link(const std::string &linkMapId, const std::string &textSegmentId,
                  const std::string &speechSegmentId, const std::string &linkTypeRaw,
                  bool hasConfidence, float confidence, const std::string &metaJsonOrEmpty,
                  PaSegmentLink *out, std::string *error = nullptr);
bool slm_remove_link(const std::string &linkMapId, const std::string &linkId,
                     std::string *error = nullptr);
std::vector<PaSegmentLink> slm_get_speech_for_text(const std::string &linkMapId,
                                                   const std::string &textSegmentId,
                                                   std::string *error = nullptr);
std::vector<PaSegmentLink> slm_get_text_for_speech(const std::string &linkMapId,
                                                   const std::string &speechSegmentId,
                                                   std::string *error = nullptr);
std::vector<PaSegmentLink> slm_get_all(const std::string &linkMapId, int startIndex, int maxCount,
                                       std::string *error = nullptr);
bool slm_get_info(const std::string &linkMapId, PaSegmentLinkMapInfo *out,
                  std::string *error = nullptr);
bool slm_release(const std::string &linkMapId);
void slm_release_all_link_maps();
