#pragma once

#include <atomic>
#include <functional>
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
  using ProgressFn = std::function<void(int percent, int completed, int total,
                                        int64_t ptsUs)>;

  static ImageBridgeResult CreateImageBuffer(
      const std::string& videoBufferId, const ImageBridgeRequest& req,
      std::atomic<bool>* cancel = nullptr, ProgressFn progress = nullptr);
};

}  // namespace video
}  // namespace sherpa_onnx
