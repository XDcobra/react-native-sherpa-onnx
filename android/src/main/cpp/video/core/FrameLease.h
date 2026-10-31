#pragma once

#include <cstdint>
#include <memory>
#include <utility>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

class FramePin {
 public:
  virtual ~FramePin() = default;
};

class VideoFrameLease {
 public:
  VideoFrameLease() = default;
  VideoFrameLease(VideoFrameView view, std::shared_ptr<FramePin> pin)
      : view_(view), pin_(std::move(pin)) {}
  VideoFrameLease(const VideoFrameLease&) = delete;
  VideoFrameLease& operator=(const VideoFrameLease&) = delete;
  VideoFrameLease(VideoFrameLease&&) noexcept = default;
  VideoFrameLease& operator=(VideoFrameLease&&) noexcept = default;

  const VideoFrameView& view() const { return view_; }
  bool valid() const { return view_.plane[0] != nullptr && pin_ != nullptr; }

 private:
  VideoFrameView view_{};
  std::shared_ptr<FramePin> pin_;
};

}  // namespace video
}  // namespace sherpa_onnx
