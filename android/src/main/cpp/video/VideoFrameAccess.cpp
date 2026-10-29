#include "VideoFrameAccess.h"

#include "VideoLog.h"
#include "VideoRegistry.h"
#include "decode/ThinningPlanner.h"
#include "live/LiveVideoEntry.h"

namespace sherpa_onnx {
namespace video {

std::vector<int64_t> SelectPresentationIndices(const Timeline& timeline,
                                               const IterateRequest& req) {
  std::vector<int64_t> out;
  const int64_t n = timeline.frameCount();
  if (n <= 0) {
    return out;
  }
  int64_t start = timeline.SampleAtPts(req.startUs);
  int64_t end = req.endUs < 0 ? n - 1 : timeline.SampleAtPts(req.endUs);
  if (start < 0) {
    start = 0;
  }
  if (end < start) {
    end = start;
  }
  auto push = [&](int64_t i) {
    if (i >= start && i <= end) {
      out.push_back(i);
    }
  };
  switch (req.sampling) {
    case SamplingMode::Keyframes: {
      SampleEntry s;
      for (int64_t i = start; i <= end; ++i) {
        if (timeline.Get(i, &s).ok && (s.flags & kSampleKey)) {
          out.push_back(i);
        }
      }
      break;
    }
    case SamplingMode::Fps: {
      if (req.fps <= 0) {
        break;
      }
      const int64_t strideUs = static_cast<int64_t>(1000000.0 / req.fps);
      int64_t t = timeline.startUs();
      if (req.startUs > t) {
        t = req.startUs;
      }
      const int64_t tEnd = req.endUs < 0 ? timeline.endUs() : req.endUs;
      while (t <= tEnd) {
        push(timeline.SampleAtPts(t));
        t += strideUs;
      }
      break;
    }
    case SamplingMode::StrideUs: {
      int64_t t = req.startUs;
      const int64_t tEnd = req.endUs < 0 ? timeline.endUs() : req.endUs;
      const int64_t stride = req.strideUs > 0 ? req.strideUs : 33333;
      while (t <= tEnd) {
        push(timeline.SampleAtPts(t));
        t += stride;
      }
      break;
    }
    case SamplingMode::Uniform: {
      const int c = req.uniformCount > 0 ? req.uniformCount : 1;
      if (end == start) {
        out.push_back(start);
        break;
      }
      for (int i = 0; i < c; ++i) {
        const int64_t idx =
            start + (end - start) * i / (c > 1 ? (c - 1) : 1);
        push(idx);
      }
      break;
    }
    case SamplingMode::Times:
      for (int64_t t : req.timesUs) {
        push(timeline.SampleAtPts(t));
      }
      break;
    case SamplingMode::All:
    default:
      for (int64_t i = start; i <= end; ++i) {
        out.push_back(i);
      }
      break;
  }
  return out;
}

VideoFrameIterator::VideoFrameIterator(std::shared_ptr<VideoEntry> entry,
                                       IterateRequest req,
                                       std::vector<int64_t> selected)
    : entry_(std::move(entry)),
      req_(std::move(req)),
      selected_(std::move(selected)) {
  if (entry_) {
    session_ = entry_->StickySession();
  }
}

Result<VideoFrameLease> VideoFrameIterator::Next() {
  Result<VideoFrameLease> r;
  if (done() || entry_ == nullptr || session_ == nullptr) {
    r.status = Status::Fail(kErrFrameOutOfRange, "iterator done");
    return r;
  }
  const int64_t pres = selected_[static_cast<size_t>(index_++)];
  SampleEntry s;
  if (entry_->timeline() == nullptr || !entry_->timeline()->Get(pres, &s).ok) {
    r.status = Status::Fail(kErrFrameOutOfRange, "sample");
    return r;
  }
  FrameRequest fr;
  fr.ptsUs = s.ptsUs;
  fr.mode = SeekMode::Accurate;
  fr.format = req_.format;
  fr.maxSide = req_.maxSide;
  fr.applyTransform = req_.applyTransform;
  fr.packed = req_.packed;
  const int flushesBefore = session_->flushCount();
  auto lease = session_->SeekAndAcquire(fr);
  if (session_->flushCount() > flushesBefore) {
    ++seekCount_;
  } else if (index_ == 1) {
    ++seekCount_;
  }
  return lease;
}

Result<VideoFrameLease> VideoFrameAccess::Acquire(const std::string& bufferId,
                                                  const FrameRequest& req) {
  Result<VideoFrameLease> r;
  auto e = VideoRegistry::Instance().Get(bufferId);
  if (!e) {
    r.status = Status::Fail(kErrBufferNotFound, bufferId);
    return r;
  }
  if (auto live = std::dynamic_pointer_cast<LiveVideoEntry>(e)) {
    if (live->state() == VideoBufferState::Recording &&
        req.mode == SeekMode::Accurate) {
      // live random Get is allowed; iterator is preferred.
    }
  }
  auto sess = e->StickySession();
  if (!sess) {
    r.status = Status::Fail(kErrDecoderUnavailable, "session");
    return r;
  }
  return sess->SeekAndAcquire(req);
}

Result<VideoFrameIterator> VideoFrameAccess::Iterate(
    const std::string& bufferId, const IterateRequest& req) {
  Result<VideoFrameIterator> r;
  auto e = VideoRegistry::Instance().Get(bufferId);
  if (!e || e->timeline() == nullptr) {
    r.status = Status::Fail(kErrBufferNotFound, bufferId);
    return r;
  }
  auto selected = SelectPresentationIndices(*e->timeline(), req);
  r.value = VideoFrameIterator(e, req, std::move(selected));
  return r;
}

}  // namespace video
}  // namespace sherpa_onnx
