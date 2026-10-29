#ifdef __ANDROID__

#include "platform/android/AMediaCodecEncoder.h"

#include "VideoLog.h"

#include <cstring>
#include <string>

namespace sherpa_onnx {
namespace video {

namespace {
std::string gEncH264;
std::string gEncHevc;
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
    return Status::Fail(kErrCodecUnsupported, "no HW encoder name");
  }
  const char* mime =
      track.codec == VideoCodec::Hevc ? "video/hevc" : "video/avc";
  AMediaFormat* fmt = AMediaFormat_new();
  AMediaFormat_setString(fmt, AMEDIAFORMAT_KEY_MIME, mime);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_WIDTH, track.codedWidth);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_HEIGHT, track.codedHeight);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_BIT_RATE, bitrate > 0 ? bitrate : 2'000'000);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_FRAME_RATE, 30);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_I_FRAME_INTERVAL, 1);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_COLOR_FORMAT, 21);  // NV12
  codec_ = AMediaCodec_createCodecByName(allowedName_.c_str());
  if (!codec_) {
    AMediaFormat_delete(fmt);
    return Status::Fail(kErrCodecUnsupported, allowedName_.c_str());
  }
  media_status_t ms =
      AMediaCodec_configure(codec_, fmt, nullptr, nullptr,
                            AMEDIACODEC_CONFIGURE_FLAG_ENCODE);
  AMediaFormat_delete(fmt);
  if (ms != AMEDIA_OK) {
    Close();
    return Status::Fail(kErrCodecUnsupported, "encoder configure");
  }
  AMediaCodec_start(codec_);
  configured_ = true;
  VIDEO_LOGI("video.encode amc %s", allowedName_.c_str());
  return Status::Ok();
}

Status AMediaCodecEncoder::Encode(const RawFrame& frame,
                                  std::vector<EncodedPacket>* out) {
  if (!configured_ || !codec_ || out == nullptr) {
    return Status::Fail(kErrCodecUnsupported, "encoder");
  }
  const ssize_t ix = AMediaCodec_dequeueInputBuffer(codec_, 10000);
  if (ix < 0) {
    return Status::Fail(kErrDecodeFailed, "enc input");
  }
  size_t cap = 0;
  uint8_t* buf = AMediaCodec_getInputBuffer(codec_, static_cast<size_t>(ix), &cap);
  const size_t yBytes =
      static_cast<size_t>(frame.nv12.y.stride) * frame.nv12.height;
  const size_t uvBytes =
      static_cast<size_t>(frame.nv12.uv.stride) * ((frame.nv12.height + 1) / 2);
  if (buf == nullptr || cap < yBytes + uvBytes) {
    return Status::Fail(kErrDecodeFailed, "enc size");
  }
  std::memcpy(buf, frame.nv12.y.data, yBytes);
  std::memcpy(buf + yBytes, frame.nv12.uv.data, uvBytes);
  AMediaCodec_queueInputBuffer(codec_, static_cast<size_t>(ix), 0,
                               yBytes + uvBytes,
                               static_cast<uint64_t>(frame.ptsUs), 0);
  AMediaCodecBufferInfo info;
  ssize_t oix = AMediaCodec_dequeueOutputBuffer(codec_, &info, 0);
  while (oix >= 0) {
    size_t osz = 0;
    uint8_t* obuf =
        AMediaCodec_getOutputBuffer(codec_, static_cast<size_t>(oix), &osz);
    if (obuf && info.size > 0) {
      EncodedPacket pkt;
      pkt.ptsUs = static_cast<int64_t>(info.presentationTimeUs);
      pkt.dtsUs = pkt.ptsUs;
      if (info.flags & AMEDIACODEC_BUFFER_FLAG_KEY_FRAME) {
        pkt.flags = kSampleKey;
      }
      pkt.payload.assign(obuf + info.offset, obuf + info.offset + info.size);
      out->push_back(std::move(pkt));
    }
    AMediaCodec_releaseOutputBuffer(codec_, static_cast<size_t>(oix), false);
    oix = AMediaCodec_dequeueOutputBuffer(codec_, &info, 0);
  }
  return Status::Ok();
}

Status AMediaCodecEncoder::Flush(std::vector<EncodedPacket>* out) {
  (void)out;
  if (codec_) {
    AMediaCodec_flush(codec_);
  }
  return Status::Ok();
}

void AMediaCodecEncoder::Close() {
  if (codec_) {
    AMediaCodec_stop(codec_);
    AMediaCodec_delete(codec_);
    codec_ = nullptr;
  }
  configured_ = false;
}

}  // namespace video
}  // namespace sherpa_onnx

#endif
