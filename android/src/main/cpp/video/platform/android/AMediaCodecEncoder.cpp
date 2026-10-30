#ifdef __ANDROID__

#include "platform/android/AMediaCodecEncoder.h"

#include "VideoLog.h"

#include <algorithm>
#include <cstring>
#include <string>

namespace sherpa_onnx {
namespace video {

namespace {
std::string gEncH264;
std::string gEncHevc;

int FpsFromTrack(const VideoTrackInfo& track) {
  if (track.nominalFps.num > 0 && track.nominalFps.den > 0) {
    const int fps =
        (track.nominalFps.num + track.nominalFps.den / 2) / track.nominalFps.den;
    return std::max(1, fps);
  }
  return 30;
}

void PackNv12(const Nv12View& nv12, std::vector<uint8_t>* packed) {
  const int w = nv12.width;
  const int h = nv12.height;
  const size_t yBytes = static_cast<size_t>(w) * static_cast<size_t>(h);
  const size_t uvBytes = static_cast<size_t>(w) * static_cast<size_t>((h + 1) / 2);
  packed->resize(yBytes + uvBytes);
  if (nv12.y.stride == w && nv12.uv.stride == w) {
    std::memcpy(packed->data(), nv12.y.data, yBytes);
    std::memcpy(packed->data() + yBytes, nv12.uv.data, uvBytes);
    return;
  }
  for (int row = 0; row < h; ++row) {
    std::memcpy(packed->data() + static_cast<size_t>(row) * static_cast<size_t>(w),
                nv12.y.data + static_cast<size_t>(row) * static_cast<size_t>(nv12.y.stride),
                static_cast<size_t>(w));
  }
  const int uvH = (h + 1) / 2;
  uint8_t* uvDst = packed->data() + yBytes;
  for (int row = 0; row < uvH; ++row) {
    std::memcpy(uvDst + static_cast<size_t>(row) * static_cast<size_t>(w),
                nv12.uv.data +
                    static_cast<size_t>(row) * static_cast<size_t>(nv12.uv.stride),
                static_cast<size_t>(w));
  }
}

}  // namespace

void AMediaCodecEncoder::SetGlobalHwEncoderName(VideoCodec codec,
                                                std::string name) {
  if (codec == VideoCodec::Hevc) {
    gEncHevc = std::move(name);
  } else {
    gEncH264 = std::move(name);
  }
}

std::string AMediaCodecEncoder::GlobalHwEncoderName(VideoCodec codec) {
  return codec == VideoCodec::Hevc ? gEncHevc : gEncH264;
}

AMediaCodecEncoder::AMediaCodecEncoder() = default;
AMediaCodecEncoder::~AMediaCodecEncoder() { Close(); }

Status AMediaCodecEncoder::Configure(const VideoTrackInfo& track, int bitrate) {
  Close();
  if (allowedName_.empty()) {
    allowedName_ = GlobalHwEncoderName(track.codec);
  }
  if (allowedName_.empty()) {
    return Status::Fail(kErrEncoderUnavailable, "no HW encoder name");
  }
  if (track.codedWidth <= 0 || track.codedHeight <= 0) {
    return Status::Fail(kErrInvalidArgument, "encoder size");
  }
  fps_ = FpsFromTrack(track);
  const char* mime =
      track.codec == VideoCodec::Hevc ? "video/hevc" : "video/avc";
  AMediaFormat* fmt = AMediaFormat_new();
  AMediaFormat_setString(fmt, AMEDIAFORMAT_KEY_MIME, mime);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_WIDTH, track.codedWidth);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_HEIGHT, track.codedHeight);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_BIT_RATE,
                        bitrate > 0 ? bitrate : 2'000'000);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_FRAME_RATE, fps_);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_I_FRAME_INTERVAL, 1);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_COLOR_FORMAT, 21);  // NV12
  codec_ = AMediaCodec_createCodecByName(allowedName_.c_str());
  if (!codec_) {
    AMediaFormat_delete(fmt);
    return Status::Fail(kErrEncoderUnavailable, allowedName_.c_str());
  }
  media_status_t ms =
      AMediaCodec_configure(codec_, fmt, nullptr, nullptr,
                            AMEDIACODEC_CONFIGURE_FLAG_ENCODE);
  AMediaFormat_delete(fmt);
  if (ms != AMEDIA_OK) {
    Close();
    return Status::Fail(kErrEncoderUnavailable, "encoder configure");
  }
  AMediaCodec_start(codec_);
  configured_ = true;
  sawEos_ = false;
  codecConfig_.clear();
  VIDEO_LOGI("video.encode amc %s fps=%d %dx%d", allowedName_.c_str(), fps_,
             track.codedWidth, track.codedHeight);
  return Status::Ok();
}

Status AMediaCodecEncoder::DrainOutputs(std::vector<EncodedPacket>* out,
                                        int64_t timeoutUs, bool untilEos) {
  if (!codec_ || out == nullptr) {
    return Status::Fail(kErrEncodeFailed, "drain");
  }
  int loops = 0;
  const int kMaxLoops = untilEos ? 64 : 8;
  while (loops++ < kMaxLoops) {
    AMediaCodecBufferInfo info;
    const ssize_t oix =
        AMediaCodec_dequeueOutputBuffer(codec_, &info, timeoutUs);
    if (oix == AMEDIACODEC_INFO_TRY_AGAIN_LATER) {
      if (untilEos && !sawEos_) {
        continue;
      }
      break;
    }
    if (oix == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED ||
        oix == AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED) {
      continue;
    }
    if (oix < 0) {
      break;
    }
    size_t osz = 0;
    uint8_t* obuf =
        AMediaCodec_getOutputBuffer(codec_, static_cast<size_t>(oix), &osz);
    const bool eos = (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) != 0;
    const bool csd = (info.flags & AMEDIACODEC_BUFFER_FLAG_CODEC_CONFIG) != 0;
    if (obuf && info.size > 0) {
      const uint8_t* begin = obuf + info.offset;
      const uint8_t* end = begin + info.size;
      if (csd) {
        codecConfig_.assign(begin, end);
        VIDEO_LOGI("video.encode amc csd bytes=%d", info.size);
      } else {
        EncodedPacket pkt;
        pkt.ptsUs = static_cast<int64_t>(info.presentationTimeUs);
        pkt.dtsUs = pkt.ptsUs;
        if (info.flags & AMEDIACODEC_BUFFER_FLAG_KEY_FRAME) {
          pkt.flags = kSampleKey;
        }
        pkt.payload.assign(begin, end);
        out->push_back(std::move(pkt));
      }
    }
    AMediaCodec_releaseOutputBuffer(codec_, static_cast<size_t>(oix), false);
    if (eos) {
      sawEos_ = true;
      break;
    }
  }
  return Status::Ok();
}

Status AMediaCodecEncoder::Encode(const RawFrame& frame,
                                  std::vector<EncodedPacket>* out) {
  if (!configured_ || !codec_ || out == nullptr) {
    return Status::Fail(kErrEncoderUnavailable, "encoder");
  }
  if (frame.nv12.width <= 0 || frame.nv12.height <= 0 ||
      frame.nv12.y.data == nullptr || frame.nv12.uv.data == nullptr) {
    return Status::Fail(kErrInvalidArgument, "enc nv12");
  }
  PackNv12(frame.nv12, &packed_);
  ssize_t ix = AMediaCodec_dequeueInputBuffer(codec_, 10000);
  if (ix < 0) {
    auto drain = DrainOutputs(out, 0, false);
    if (!drain.ok) {
      return drain;
    }
    ix = AMediaCodec_dequeueInputBuffer(codec_, 20000);
  }
  if (ix < 0) {
    return Status::Fail(kErrEncodeFailed, "enc input");
  }
  size_t cap = 0;
  uint8_t* buf = AMediaCodec_getInputBuffer(codec_, static_cast<size_t>(ix), &cap);
  if (buf == nullptr || cap < packed_.size()) {
    return Status::Fail(kErrEncodeFailed, "enc size");
  }
  std::memcpy(buf, packed_.data(), packed_.size());
  media_status_t q = AMediaCodec_queueInputBuffer(
      codec_, static_cast<size_t>(ix), 0, packed_.size(),
      static_cast<uint64_t>(frame.ptsUs), 0);
  if (q != AMEDIA_OK) {
    return Status::Fail(kErrEncodeFailed, "enc queue");
  }
  return DrainOutputs(out, 0, false);
}

Status AMediaCodecEncoder::Flush(std::vector<EncodedPacket>* out) {
  if (!configured_ || !codec_ || out == nullptr) {
    return Status::Fail(kErrEncoderUnavailable, "encoder flush");
  }
  ssize_t ix = AMediaCodec_dequeueInputBuffer(codec_, 20000);
  if (ix < 0) {
    auto drain = DrainOutputs(out, 10000, false);
    if (!drain.ok) {
      return drain;
    }
    ix = AMediaCodec_dequeueInputBuffer(codec_, 20000);
  }
  if (ix < 0) {
    return Status::Fail(kErrEncodeFailed, "enc eos input");
  }
  media_status_t q = AMediaCodec_queueInputBuffer(
      codec_, static_cast<size_t>(ix), 0, 0, 0,
      AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM);
  if (q != AMEDIA_OK) {
    return Status::Fail(kErrEncodeFailed, "enc eos queue");
  }
  return DrainOutputs(out, 20000, true);
}

void AMediaCodecEncoder::Close() {
  if (codec_) {
    AMediaCodec_stop(codec_);
    AMediaCodec_delete(codec_);
    codec_ = nullptr;
  }
  configured_ = false;
  sawEos_ = false;
  codecConfig_.clear();
  packed_.clear();
}

}  // namespace video
}  // namespace sherpa_onnx

#endif
