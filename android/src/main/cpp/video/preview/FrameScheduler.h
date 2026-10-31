#pragma once

#include <cstdint>

namespace sherpa_onnx {
namespace video {
namespace preview {

enum class FrameDecision : uint8_t { Drop, Wait, Release };

struct FrameScheduleResult {
  FrameDecision decision = FrameDecision::Wait;
  int64_t releaseAtNs = 0;
};

class FrameScheduler {
 public:
  static FrameScheduleResult Decide(int64_t framePtsUs, int64_t clockUs,
                                    int64_t nowNs, int64_t vsyncNs,
                                    int64_t frameDurUs);
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
