#pragma once

#include <cstdint>
#include <optional>
#include <string>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

struct VideoFileProbe {
  std::string inputFormatName;
  std::string codecName;
  int codedWidth = 0;
  int codedHeight = 0;
  int64_t durationUs = 0;
  bool durationExact = false;
  std::optional<std::string> audioCodecName;
};

/** Content sniff only: no sample index, no VideoBuffer, no HW decode. */
Status ProbeVideoFile(const std::string& path, VideoFileProbe* out);

}  // namespace video
}  // namespace sherpa_onnx
