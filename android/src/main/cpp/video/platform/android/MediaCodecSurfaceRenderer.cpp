#ifdef __ANDROID__

#include "platform/android/MediaCodecSurfaceRenderer.h"

#include "VideoLog.h"
#include "demux/BitstreamUtil.h"
#include "platform/android/AMediaCodecDecoder.h"

#include <cstring>

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
  if (!track_.codecConfig.empty()) {
    AMediaFormat_setBuffer(fmt, "csd-0", track_.codecConfig.data(),
                           track_.codecConfig.size());
  }
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
  (void)displayFlag;
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
    return Status::Ok();
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
  ++inputBusy_;
  return Status::Ok();
}

bool MediaCodecSurfaceRenderer::ReadyForMore() const {
  std::lock_guard<std::mutex> lock(mu_);
  return codec_ != nullptr && inputBusy_ < 4 && heldOutput_ < 0;
}

void MediaCodecSurfaceRenderer::Flush(uint64_t gen) {
  std::lock_guard<std::mutex> lock(mu_);
  gen_ = gen;
  firstShown_ = false;
  eosQueued_ = false;
  heldOutput_ = -1;
  inputBusy_ = 0;
  if (codec_) AMediaCodec_flush(codec_);
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
        if (onFirstFrameShown) onFirstFrameShown(gen_, heldPtsUs_);
      }
      if (onFrameShown) onFrameShown(gen_, heldPtsUs_);
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

  if (heldOutput_ >= 0) {
    auto d = FrameScheduler::Decide(heldPtsUs_, clockUs, nowNs, vs, 33333);
    if (d.decision == FrameDecision::Drop) {
      releaseHeld(false, 0);
    } else if (d.decision == FrameDecision::Release) {
      releaseHeld(heldDisplay_, d.releaseAtNs);
    } else {
      return;
    }
  }

  AMediaCodecBufferInfo info;
  const ssize_t ix = AMediaCodec_dequeueOutputBuffer(codec_, &info, 5000);
  if (ix < 0) return;
  if (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) {
    AMediaCodec_releaseOutputBuffer(codec_, static_cast<size_t>(ix), false);
    if (onEos) onEos(gen_);
    return;
  }
  heldOutput_ = static_cast<int>(ix);
  heldPtsUs_ = info.presentationTimeUs;
  heldDisplay_ = info.size > 0;
  auto d = FrameScheduler::Decide(heldPtsUs_, clockUs, nowNs, vs, 33333);
  if (d.decision == FrameDecision::Drop) {
    releaseHeld(false, 0);
  } else if (d.decision == FrameDecision::Release) {
    releaseHeld(heldDisplay_, d.releaseAtNs);
  }
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
  heldOutput_ = -1;
  inputBusy_ = 0;
}

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx

#endif
