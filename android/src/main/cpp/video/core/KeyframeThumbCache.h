#pragma once

#include <memory>

#include "core/DecodedFrameCache.h"
#include "decode/DecodeSession.h"

namespace sherpa_onnx {
namespace video {

/** Keyframe-only decode at longest edge ≤ 320. Separate from analysis cache. */
class KeyframeThumbCache {
 public:
  static constexpr int kMaxSide = 320;

  explicit KeyframeThumbCache(std::shared_ptr<DecodedFrameCache> cache)
      : cache_(std::move(cache)) {}

  Result<VideoFrameLease> Get(DecodeSession* session, int64_t tUs) {
    if (session == nullptr) {
      Result<VideoFrameLease> r;
      r.status = Status::Fail(kErrInvalidArgument, "thumb session");
      return r;
    }
    FrameRequest req;
    req.ptsUs = tUs;
    req.mode = SeekMode::ClosestKeyframe;
    req.format = VideoPixelFormat::Rgb24;
    req.maxSide = kMaxSide;
    req.applyTransform = true;
    req.packed = true;
    return session->SeekAndAcquire(req);
  }

  void Drop() {
    if (cache_) {
      cache_->ClearUnpinned();
    }
  }

 private:
  std::shared_ptr<DecodedFrameCache> cache_;
};

}  // namespace video
}  // namespace sherpa_onnx
