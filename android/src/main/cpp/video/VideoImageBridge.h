#pragma once

#include <string>
#include <vector>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

struct ImageBridgeRequest {
  SamplingMode sampling = SamplingMode::All;
  double fps = 0;
  int uniformCount = 0;
  SeekMode mode = SeekMode::Accurate;
  int maxSide = 0;
  int64_t startUs = 0;
  int64_t endUs = -1;
  std::vector<int64_t> timesUs;
};

struct ImageBridgeResult {
  Status status;
  std::string imageBufferId;
  int frameCount = 0;
};

class VideoImageBridge {
 public:
  static ImageBridgeResult CreateImageBuffer(const std::string& videoBufferId,
                                             const ImageBridgeRequest& req);
};

}  // namespace video
}  // namespace sherpa_onnx
