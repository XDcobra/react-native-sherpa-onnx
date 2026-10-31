#ifdef __ANDROID__

#include "platform/android/MediaCodecSurfaceRenderer.h"

#include "VideoLog.h"
#include "demux/BitstreamUtil.h"
#include "platform/android/AMediaCodecDecoder.h"

#include <cstring>
#include <functional>

namespace sherpa_onnx {
namespace video {
namespace preview {

MediaCodecSurfaceRenderer::MediaCodecSurfaceRenderer() = default;

MediaCodecSurfaceRenderer::~MediaCodecSurfaceRenderer() { Close(); }

void MediaCodecSurfaceRenderer::SetWindow(ANativeWindow* window) {
  std::lock_guard<std::mutex> lock(mu_);
  window_ = window;
}

void MediaCodecSurfaceRenderer::SetRefreshHz(double hz) {
  if (hz <= 1.0) hz = 60.0;
  vsyncNs_.store(static_cast<int64_t>(1e9 / hz));
}

Status MediaCodecSurfaceRenderer::EnsureCodec() {
  if (codec_ != nullptr) return Status::Ok();
  if (window_ == nullptr) {
    return Status::Fail(kErrPreviewRenderFailed, "no surface");
  }
  allowedName_ = AMediaCodecDecoder::GlobalHwDecoderName(track_.codec);
  if (allowedName_.empty()) {
    return Status::Fail(kErrDecoderUnavailable, "no HW decoder name");
  }
  const char* mime =
      track_.codec == VideoCodec::Hevc ? "video/hevc" : "video/avc";
  AMediaFormat* fmt = AMediaFormat_new();
  AMediaFormat_setString(fmt, AMEDIAFORMAT_KEY_MIME, mime);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_WIDTH, track_.codedWidth);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_HEIGHT, track_.codedHeight);
  if (track_.transform.rotationDegrees != 0) {
    AMediaFormat_setInt32(fmt, "rotation-degrees",
                          track_.transform.rotationDegrees);
  }
  AMediaCodecDecoder::ApplyCsd(fmt, track_.codec, track_.codecConfig);
  codec_ = AMediaCodec_createCodecByName(allowedName_.c_str());
  if (codec_ == nullptr) {
    AMediaFormat_delete(fmt);
    return Status::Fail(kErrDecoderUnavailable, allowedName_.c_str());
  }
  media_status_t ms =
      AMediaCodec_configure(codec_, fmt, window_, nullptr, 0);
  AMediaFormat_delete(fmt);
  if (ms != AMEDIA_OK) {
    AMediaCodec_delete(codec_);
    codec_ = nullptr;
    return Status::Fail(kErrDecoderUnavailable, "configure surface");
  }
  AMediaCodec_start(codec_);
  configured_ = true;
  queuedSinceStart_ = false;
  VIDEO_LOGI("video.preview amc surface %s %dx%d", allowedName_.c_str(),
             track_.codedWidth, track_.codedHeight);
  return Status::Ok();
}

Status MediaCodecSurfaceRenderer::Configure(const VideoTrackInfo& track) {
  std::lock_guard<std::mutex> lock(mu_);
  Close();
  track_ = track;
  firstShown_ = false;
  return EnsureCodec();
}

Status MediaCodecSurfaceRenderer::Submit(const EncodedPacket& pkt,
                                         bool displayFlag, uint64_t gen) {
  std::lock_guard<std::mutex> lock(mu_);
  gen_ = gen;
  auto st = EnsureCodec();
  if (!st.ok) return st;
  std::vector<uint8_t> annexb;
  const uint8_t* data = pkt.payload.data();
  size_t size = pkt.payload.size();
  if (BitstreamUtil::LooksAvcc(data, size)) {
    st = BitstreamUtil::AvccToAnnexB(data, size, &annexb);
    if (!st.ok) return st;
    data = annexb.data();
    size = annexb.size();
  }
  const ssize_t ix = AMediaCodec_dequeueInputBuffer(codec_, 0);
  if (ix < 0) {
    return Status::Fail(kErrTryAgain, "input buffer");
  }
  size_t bufSize = 0;
  uint8_t* buf = AMediaCodec_getInputBuffer(codec_, static_cast<size_t>(ix),
                                            &bufSize);
  if (buf == nullptr || bufSize < size) {
    return Status::Fail(kErrDecodeFailed, "input size");
  }
  std::memcpy(buf, data, size);
  uint32_t flags = 0;
  if (pkt.flags & kSampleKey) {
    flags |= AMEDIACODEC_BUFFER_FLAG_KEY_FRAME;
  }
  AMediaCodec_queueInputBuffer(codec_, static_cast<size_t>(ix), 0, size,
                               static_cast<uint64_t>(pkt.ptsUs), flags);
  displayByPts_[pkt.ptsUs] = displayFlag;
  ++inputBusy_;
  queuedSinceStart_ = true;
  return Status::Ok();
}

bool MediaCodecSurfaceRenderer::ReadyForMore() const {
  std::lock_guard<std::mutex> lock(mu_);
  return codec_ != nullptr && inputBusy_ < 4 && heldOutput_ < 0;
}

void MediaCodecSurfaceRenderer::SetPrerollUntil(int64_t tUs) {
  std::lock_guard<std::mutex> lock(mu_);
  prerollUntilUs_ = tUs;
}

void MediaCodecSurfaceRenderer::Flush(uint64_t gen) {
  std::lock_guard<std::mutex> lock(mu_);
  gen_ = gen;
  firstShown_ = false;
  displayByPts_.clear();
  prerollUntilUs_ = 0;
  const bool afterEos = eosQueued_;
  eosQueued_ = false;
  heldOutput_ = -1;
  inputBusy_ = 0;
  if (!codec_) return;
  // After BUFFER_FLAG_END_OF_STREAM, flush is not enough on some devices —
  // recreate so the next loop/seek can decode from the start again.
  if (afterEos) {
    VIDEO_LOGW("video.preview.flush recreate_after_eos gen=%llu",
               static_cast<unsigned long long>(gen));
    Close();
    (void)EnsureCodec();
    queuedSinceStart_ = false;
    return;
  }
  if (queuedSinceStart_) {
    AMediaCodec_flush(codec_);
    queuedSinceStart_ = false;
  }
}

void MediaCodecSurfaceRenderer::SignalEos(uint64_t gen) {
  std::lock_guard<std::mutex> lock(mu_);
  gen_ = gen;
  if (!codec_ || eosQueued_) return;
  const ssize_t ix = AMediaCodec_dequeueInputBuffer(codec_, 0);
  if (ix < 0) return;
  AMediaCodec_queueInputBuffer(codec_, static_cast<size_t>(ix), 0, 0, 0,
                               AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM);
  eosQueued_ = true;
}

void MediaCodecSurfaceRenderer::Drain(int64_t clockUs, int64_t nowNs,
                                      int64_t vsyncNs) {
  std::function<void(uint64_t, int64_t)> firstCb;
  std::function<void(uint64_t, int64_t)> frameCb;
  std::function<void(uint64_t)> eosCb;
  uint64_t cbGen = 0;
  int64_t cbPts = 0;
  bool fireFirst = false;
  bool fireFrame = false;
  bool fireEos = false;

  {
    std::lock_guard<std::mutex> lock(mu_);
    if (!codec_) return;
    const int64_t vs = vsyncNs > 0 ? vsyncNs : vsyncNs_.load();
    auto releaseHeld = [&](bool render, int64_t atNs) {
      if (heldOutput_ < 0) return;
      if (render) {
        AMediaCodec_releaseOutputBufferAtTime(codec_,
                                              static_cast<size_t>(heldOutput_),
                                              atNs);
        ++stats_.rendered;
        if (!firstShown_) {
          firstShown_ = true;
          fireFirst = true;
          cbGen = gen_;
          cbPts = heldPtsUs_;
          firstCb = onFirstFrameShown;
        }
        fireFrame = true;
        frameCb = onFrameShown;
        stats_.avOffsetMsMean =
            stats_.avOffsetMsMean * 0.9 + (heldPtsUs_ - clockUs) / 10000.0;
      } else {
        AMediaCodec_releaseOutputBuffer(codec_, static_cast<size_t>(heldOutput_),
                                        false);
        ++stats_.dropped;
      }
      heldOutput_ = -1;
      if (inputBusy_ > 0) --inputBusy_;
    };

    auto decide = [&](int64_t ptsUs) {
      // Clock is frozen (rate 0) while seeking. Waiting for pts≈clock would
      // hold the first frame forever and never leave PreviewState::Seeking.
      if (!firstShown_) {
        FrameScheduleResult r;
        r.decision = FrameDecision::Release;
        r.releaseAtNs = nowNs;
        return r;
      }
      return FrameScheduler::Decide(ptsUs, clockUs, nowNs, vs, 33333);
    };

    if (heldOutput_ >= 0) {
      auto d = decide(heldPtsUs_);
      if (d.decision == FrameDecision::Drop) {
        releaseHeld(false, 0);
      } else if (d.decision == FrameDecision::Release) {
        releaseHeld(heldDisplay_, d.releaseAtNs);
      } else {
        return;
      }
    }

    AMediaCodecBufferInfo info;
    ssize_t ix = -1;
    for (int n = 0; n < 4; ++n) {
      ix = AMediaCodec_dequeueOutputBuffer(codec_, &info, n == 0 ? 5000 : 0);
      if (ix == AMEDIACODEC_INFO_TRY_AGAIN_LATER) {
        return;
      }
      if (ix == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED ||
          ix == AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED) {
        continue;
      }
      break;
    }
    if (ix < 0) return;
      if (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) {
      AMediaCodec_releaseOutputBuffer(codec_, static_cast<size_t>(ix), false);
      fireEos = true;
      cbGen = gen_;
      eosCb = onEos;
    } else {
      heldOutput_ = static_cast<int>(ix);
      heldPtsUs_ = info.presentationTimeUs;
      heldDisplay_ = true;
      auto it = displayByPts_.find(info.presentationTimeUs);
      if (it != displayByPts_.end()) {
        heldDisplay_ = it->second;
        displayByPts_.erase(it);
      } else if (prerollUntilUs_ > 0 &&
                 info.presentationTimeUs < prerollUntilUs_) {
        heldDisplay_ = false;
      }
      auto d = decide(heldPtsUs_);
      if (d.decision == FrameDecision::Drop) {
        releaseHeld(false, 0);
      } else if (d.decision == FrameDecision::Release) {
        releaseHeld(heldDisplay_, d.releaseAtNs);
      }
    }
  }

  // Callbacks must run without mu_: loop seek Flushes the codec (same mutex).
  if (fireEos && eosCb) eosCb(cbGen);
  if (fireFirst && firstCb) firstCb(cbGen, cbPts);
  if (fireFrame && frameCb) frameCb(cbGen, cbPts);
}

VideoRenderStats MediaCodecSurfaceRenderer::stats() const {
  std::lock_guard<std::mutex> lock(mu_);
  return stats_;
}

void MediaCodecSurfaceRenderer::Close() {
  if (codec_) {
    AMediaCodec_stop(codec_);
    AMediaCodec_delete(codec_);
    codec_ = nullptr;
  }
  configured_ = false;
  queuedSinceStart_ = false;
  heldOutput_ = -1;
  inputBusy_ = 0;
}

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx

#endif
