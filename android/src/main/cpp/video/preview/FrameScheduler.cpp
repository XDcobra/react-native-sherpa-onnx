#include "preview/FrameScheduler.h"

#include <algorithm>

namespace sherpa_onnx {
namespace video {
namespace preview {

FrameScheduleResult FrameScheduler::Decide(int64_t framePtsUs, int64_t clockUs,
                                           int64_t nowNs, int64_t vsyncNs,
                                           int64_t frameDurUs) {
  FrameScheduleResult r;
  const int64_t lateUs = clockUs - framePtsUs;
  const int64_t earlyUs = framePtsUs - clockUs;
  const int64_t dropThresh = std::max(frameDurUs, static_cast<int64_t>(40000));
  if (lateUs > dropThresh) {
    r.decision = FrameDecision::Drop;
    return r;
  }
  const int64_t vs = vsyncNs > 0 ? vsyncNs : 16666666;
  if (earlyUs > (2 * vs) / 1000) {
    r.decision = FrameDecision::Wait;
    r.releaseAtNs = nowNs + (framePtsUs - clockUs) * 1000;
    return r;
  }
  r.decision = FrameDecision::Release;
  r.releaseAtNs = nowNs + (framePtsUs - clockUs) * 1000;
  return r;
}

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
