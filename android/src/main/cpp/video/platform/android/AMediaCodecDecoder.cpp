#ifdef __ANDROID__

#include "platform/android/AMediaCodecDecoder.h"

#include "VideoLog.h"
#include "demux/BitstreamUtil.h"

#include "libyuv/convert.h"
#include "libyuv/convert_from.h"

#include <cstring>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace video {

namespace {
std::string gHwH264;
std::string gHwHevc;
}  // namespace

void AMediaCodecDecoder::SetGlobalHwDecoderName(VideoCodec codec,
                                                std::string name) {
  if (codec == VideoCodec::Hevc) {
    gHwHevc = std::move(name);
  } else {
    gHwH264 = std::move(name);
  }
}

std::string AMediaCodecDecoder::GlobalHwDecoderName(VideoCodec codec) {
  return codec == VideoCodec::Hevc ? gHwHevc : gHwH264;
}

AMediaCodecDecoder::AMediaCodecDecoder() = default;

AMediaCodecDecoder::~AMediaCodecDecoder() { Close(); }

Status AMediaCodecDecoder::Configure(const VideoTrackInfo& track) {
  Close();
  if (allowedName_.empty()) {
    allowedName_ = GlobalHwDecoderName(track.codec);
  }
  if (allowedName_.empty()) {
    return Status::Fail(kErrDecoderUnavailable, "no HW decoder name");
  }
  track_ = track;
  const char* mime =
      track.codec == VideoCodec::Hevc ? "video/hevc" : "video/avc";
  AMediaFormat* fmt = AMediaFormat_new();
  AMediaFormat_setString(fmt, AMEDIAFORMAT_KEY_MIME, mime);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_WIDTH, track.codedWidth);
  AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_HEIGHT, track.codedHeight);
  if (!track.codecConfig.empty()) {
    AMediaFormat_setBuffer(fmt, "csd-0", track.codecConfig.data(),
                           track.codecConfig.size());
  }
  media_status_t ms = AImageReader_new(track.codedWidth, track.codedHeight,
                                       AIMAGE_FORMAT_YUV_420_888, 4, &reader_);
  if (ms != AMEDIA_OK || reader_ == nullptr) {
    AMediaFormat_delete(fmt);
    return Status::Fail(kErrDecoderUnavailable, "AImageReader");
  }
  AImageReader_getWindow(reader_, &window_);
  codec_ = AMediaCodec_createCodecByName(allowedName_.c_str());
  if (codec_ == nullptr) {
    AMediaFormat_delete(fmt);
    Close();
    return Status::Fail(kErrDecoderUnavailable, allowedName_.c_str());
  }
  ms = AMediaCodec_configure(codec_, fmt, window_, nullptr, 0);
  AMediaFormat_delete(fmt);
  if (ms != AMEDIA_OK) {
    Close();
    return Status::Fail(kErrDecoderUnavailable, "configure");
  }
  AMediaCodec_start(codec_);
  configured_ = true;
  VIDEO_LOGI("video.decode amc %s %dx%d", allowedName_.c_str(),
             track.codedWidth, track.codedHeight);
  return Status::Ok();
}

Status AMediaCodecDecoder::Submit(const EncodedPacket& packet) {
  if (!configured_ || codec_ == nullptr) {
    return Status::Fail(kErrDecoderUnavailable, "not configured");
  }
  std::vector<uint8_t> annexb;
  const uint8_t* data = packet.payload.data();
  size_t size = packet.payload.size();
  if (BitstreamUtil::LooksAvcc(data, size)) {
    auto st = BitstreamUtil::AvccToAnnexB(data, size, &annexb);
    if (!st.ok) {
      return st;
    }
    data = annexb.data();
    size = annexb.size();
  }
  const ssize_t ix = AMediaCodec_dequeueInputBuffer(codec_, 10000);
  if (ix < 0) {
    return Status::Fail(kErrDecodeFailed, "input buffer");
  }
  size_t bufSize = 0;
  uint8_t* buf = AMediaCodec_getInputBuffer(codec_, static_cast<size_t>(ix),
                                            &bufSize);
  if (buf == nullptr || bufSize < size) {
    return Status::Fail(kErrDecodeFailed, "input size");
  }
  std::memcpy(buf, data, size);
  uint32_t flags = 0;
  if (packet.flags & kSampleKey) {
    flags |= AMEDIACODEC_BUFFER_FLAG_KEY_FRAME;
  }
  AMediaCodec_queueInputBuffer(codec_, static_cast<size_t>(ix), 0, size,
                               static_cast<uint64_t>(packet.ptsUs), flags);
  ++submitCount_;
  return Status::Ok();
}

Status AMediaCodecDecoder::Flush() {
  if (codec_) {
    AMediaCodec_flush(codec_);
  }
  ++flushCount_;
  return Status::Ok();
}

bool AMediaCodecDecoder::Receive(DecodedRawFrame* out) {
  if (!configured_ || codec_ == nullptr || out == nullptr) {
    return false;
  }
  AMediaCodecBufferInfo info;
  const ssize_t ix = AMediaCodec_dequeueOutputBuffer(codec_, &info, 0);
  if (ix < 0) {
    return false;
  }
  AImage* image = nullptr;
  if (reader_ && AImageReader_acquireLatestImage(reader_, &image) == AMEDIA_OK &&
      image != nullptr) {
    CopyImageToFrame(image, out, static_cast<int64_t>(info.presentationTimeUs));
    AImage_delete(image);
  }
  AMediaCodec_releaseOutputBuffer(codec_, static_cast<size_t>(ix), false);
  return out->view.y.data != nullptr;
}

Status AMediaCodecDecoder::CopyImageToFrame(AImage* image, DecodedRawFrame* out,
                                            int64_t ptsUs) {
  int32_t w = 0, h = 0, yStride = 0, uStride = 0, vStride = 0;
  int32_t yPix = 1, uPix = 1, vPix = 1;
  uint8_t *y = nullptr, *u = nullptr, *v = nullptr;
  int yLen = 0, uLen = 0, vLen = 0;
  AImage_getWidth(image, &w);
  AImage_getHeight(image, &h);
  AImage_getPlaneRowStride(image, 0, &yStride);
  AImage_getPlaneRowStride(image, 1, &uStride);
  AImage_getPlaneRowStride(image, 2, &vStride);
  AImage_getPlanePixelStride(image, 0, &yPix);
  AImage_getPlanePixelStride(image, 1, &uPix);
  AImage_getPlanePixelStride(image, 2, &vPix);
  AImage_getPlaneData(image, 0, &y, &yLen);
  AImage_getPlaneData(image, 1, &u, &uLen);
  AImage_getPlaneData(image, 2, &v, &vLen);
  const int dstYStride = AlignUp(w);
  const int dstUvStride = AlignUp(w);
  const int i420Y = AlignUp(w);
  const int i420U = AlignUp((w + 1) / 2);
  const size_t i420Bytes =
      static_cast<size_t>(i420Y) * h +
      static_cast<size_t>(i420U) * ((h + 1) / 2) * 2;
  const size_t nvBytes =
      static_cast<size_t>(dstYStride) * h +
      static_cast<size_t>(dstUvStride) * ((h + 1) / 2);
  std::vector<uint8_t> i420(i420Bytes);
  uint8_t* iy = i420.data();
  uint8_t* iu = iy + static_cast<size_t>(i420Y) * h;
  uint8_t* iv = iu + static_cast<size_t>(i420U) * ((h + 1) / 2);
  libyuv::Android420ToI420(y, yStride, u, uStride, v, vStride, uPix, iy, i420Y,
                           iu, i420U, iv, i420U, w, h);
  auto st = out->storage.Allocate(nvBytes);
  if (!st.ok) {
    return st;
  }
  uint8_t* dstY = out->storage.data();
  uint8_t* dstUv = dstY + static_cast<size_t>(dstYStride) * h;
  libyuv::I420ToNV12(iy, i420Y, iu, i420U, iv, i420U, dstY, dstYStride, dstUv,
                     dstUvStride, w, h);
  out->view.y.data = dstY;
  out->view.y.stride = dstYStride;
  out->view.uv.data = dstUv;
  out->view.uv.stride = dstUvStride;
  out->view.width = w;
  out->view.height = h;
  out->ptsUs = ptsUs;
  return Status::Ok();
}

void AMediaCodecDecoder::Close() {
  if (codec_) {
    AMediaCodec_stop(codec_);
    AMediaCodec_delete(codec_);
    codec_ = nullptr;
  }
  if (reader_) {
    AImageReader_delete(reader_);
    reader_ = nullptr;
    window_ = nullptr;
  }
  configured_ = false;
}

}  // namespace video
}  // namespace sherpa_onnx

#endif
