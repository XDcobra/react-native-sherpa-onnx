#pragma once

#include <memory>
#include <vector>

#include "VideoTypes.h"
#include "core/FrameLease.h"
#include "decode/DecodeSession.h"

namespace sherpa_onnx {
namespace video {

class VideoEntry;

std::vector<int64_t> SelectPresentationIndices(const Timeline& timeline,
                                               const IterateRequest& req);

class VideoFrameIterator {
 public:
  VideoFrameIterator() = default;
  VideoFrameIterator(std::shared_ptr<VideoEntry> entry, IterateRequest req,
                     std::vector<int64_t> selected);
  Result<VideoFrameLease> Next();
  bool done() const { return index_ >= static_cast<int64_t>(selected_.size()); }
  int seekCount() const { return seekCount_; }

 private:
  std::shared_ptr<VideoEntry> entry_;
  IterateRequest req_;
  std::vector<int64_t> selected_;
  int64_t index_ = 0;
  int seekCount_ = 0;
  std::shared_ptr<DecodeSession> session_;
};

class VideoFrameAccess {
 public:
  static Result<VideoFrameLease> Acquire(const std::string& bufferId,
                                         const FrameRequest& req);
  static Result<VideoFrameIterator> Iterate(const std::string& bufferId,
                                            const IterateRequest& req);
};

}  // namespace video
}  // namespace sherpa_onnx
