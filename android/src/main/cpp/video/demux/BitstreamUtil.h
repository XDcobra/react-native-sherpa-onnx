#pragma once

#include <cstdint>
#include <vector>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

struct NalInfo {
  bool isKey = false;
  bool isNonRef = false;
  uint8_t nalType = 0;
};

class BitstreamUtil {
 public:
  /** AVCC (4-byte length prefix) → Annex-B start codes. */
  static Status AvccToAnnexB(const uint8_t* data, size_t size,
                             std::vector<uint8_t>* out);
  static Status AnnexBToAvcc(const uint8_t* data, size_t size,
                             std::vector<uint8_t>* out);

  static bool LooksAvcc(const uint8_t* data, size_t size);
  static bool LooksAnnexB(const uint8_t* data, size_t size);

  static NalInfo InspectH264AccessUnit(const uint8_t* data, size_t size,
                                       bool avcc);
  static NalInfo InspectHevcAccessUnit(const uint8_t* data, size_t size,
                                       bool avcc);

  /** Pull SPS/PPS (H.264) or VPS/SPS/PPS (HEVC) from avcC / hvcC. */
  static Status ExtractH264ParameterSets(const std::vector<uint8_t>& avcc,
                                         std::vector<std::vector<uint8_t>>* sps,
                                         std::vector<std::vector<uint8_t>>* pps);
  static Status ExtractHevcParameterSets(
      const std::vector<uint8_t>& hvcc, std::vector<std::vector<uint8_t>>* vps,
      std::vector<std::vector<uint8_t>>* sps,
      std::vector<std::vector<uint8_t>>* pps);
};

}  // namespace video
}  // namespace sherpa_onnx
