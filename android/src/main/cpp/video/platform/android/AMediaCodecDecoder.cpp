#ifdef __ANDROID__

#include "platform/android/AMediaCodecDecoder.h"

#include "VideoLog.h"
#include "demux/BitstreamUtil.h"

#include "libyuv/convert.h"
#include "libyuv/convert_from.h"

#include <media/NdkMediaError.h>

#include <chrono>
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

void AMediaCodecDecoder::ApplyCsd(AMediaFormat* fmt, VideoCodec codec,
                                  const std::vector<uint8_t>& config) {
  if (fmt == nullptr || config.empty()) return;
  BitstreamUtil::AnnexBCsd csd;
  auto st = BitstreamUtil::MakeAnnexBCsd(codec, config, &csd);
  if (!st.ok || csd.csd0.empty()) {
    AMediaFormat_setBuffer(fmt, "csd-0", config.data(), config.size());
    VIDEO_LOGW("video.decode csd fallback raw=%zu code=%s", config.size(),
               st.errorMessage.c_str());
    return;
  }
  AMediaFormat_setBuffer(fmt, "csd-0", csd.csd0.data(), csd.csd0.size());
  if (!csd.csd1.empty()) {
    AMediaFormat_setBuffer(fmt, "csd-1", csd.csd1.data(), csd.csd1.size());
  }
  VIDEO_LOGI("video.decode csd codec=%d csd0=%zu csd1=%zu",
             static_cast<int>(codec), csd.csd0.size(), csd.csd1.size());
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
  ApplyCsd(fmt, track.codec, track.codecConfig);
  media_status_t ms = AImageReader_new(track.codedWidth, track.codedHeight,
                                       AIMAGE_FORMAT_YUV_420_888, 8, &reader_);
  if (ms != AMEDIA_OK || reader_ == nullptr) {
    AMediaFormat_delete(fmt);
    return Status::Fail(kErrDecoderUnavailable, "AImageReader");
  }
  listener_.context = this;
  listener_.onImageAvailable = &AMediaCodecDecoder::OnImageAvailable;
  AImageReader_setImageListener(reader_, &listener_);
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
  queuedSinceStart_ = true;
  ++submitCount_;
  return Status::Ok();
}

Status AMediaCodecDecoder::Flush() {
  imageGen_.fetch_add(1);
  if (codec_ && queuedSinceStart_) {
    AMediaCodec_flush(codec_);
    queuedSinceStart_ = false;
  }
  {
    std::lock_guard<std::mutex> lock(outMu_);
    pendingPtsUs_.clear();
    out_.clear();
  }
  ++flushCount_;
  return Status::Ok();
}

void AMediaCodecDecoder::OnImageAvailable(void* context, AImageReader* reader) {
  (void)reader;
  auto* self = static_cast<AMediaCodecDecoder*>(context);
  if (self == nullptr) {
    return;
  }
  self->DrainImages();
}

void AMediaCodecDecoder::PumpCodec(int64_t timeoutUs) {
  if (!configured_ || codec_ == nullptr) {
    return;
  }
  int64_t waitUs = timeoutUs < 0 ? 0 : timeoutUs;
  for (int spin = 0; spin < 8; ++spin) {
    AMediaCodecBufferInfo info;
    const ssize_t ix =
        AMediaCodec_dequeueOutputBuffer(codec_, &info, waitUs);
    if (ix == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED ||
        ix == AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED) {
      VIDEO_LOGI("video.decode amc info ix=%zd spin=%d",
                 static_cast<ssize_t>(ix), spin);
      waitUs = 0;
      continue;
    }
    if (ix < 0) {
      return;
    }
    {
      std::lock_guard<std::mutex> lock(outMu_);
      pendingPtsUs_.push_back(static_cast<int64_t>(info.presentationTimeUs));
    }
    // Surface/ImageReader mode: render=true delivers the buffer to AImageReader.
    AMediaCodec_releaseOutputBuffer(codec_, static_cast<size_t>(ix), true);
    VIDEO_LOGI("video.decode amc render ix=%zd ptsUs=%lld flags=%u",
               static_cast<ssize_t>(ix),
               static_cast<long long>(info.presentationTimeUs),
               static_cast<unsigned>(info.flags));
    DrainImages();
    {
      std::unique_lock<std::mutex> lock(outMu_);
      if (pendingPtsUs_.size() > 2) {
        VIDEO_LOGI("video.decode amc backpressure pending=%zu out=%zu",
                   pendingPtsUs_.size(), out_.size());
        outCv_.wait_for(lock, std::chrono::milliseconds(50), [this] {
          return pendingPtsUs_.size() <= 2;
        });
      }
    }
    return;
  }
}

void AMediaCodecDecoder::DrainImages() {
  if (reader_ == nullptr) {
    return;
  }
  const uint64_t gen = imageGen_.load();
  for (;;) {
    AImage* image = nullptr;
    const media_status_t acq = AImageReader_acquireNextImage(reader_, &image);
    if (acq != AMEDIA_OK || image == nullptr) {
      if (acq != AMEDIA_IMGREADER_NO_BUFFER_AVAILABLE) {
        VIDEO_LOGW("video.decode amc acquire acq=%d", static_cast<int>(acq));
      }
      return;
    }
    if (gen != imageGen_.load()) {
      AImage_delete(image);
      continue;
    }
    int64_t ptsUs = 0;
    {
      std::lock_guard<std::mutex> lock(outMu_);
      if (!pendingPtsUs_.empty()) {
        ptsUs = pendingPtsUs_.front();
        pendingPtsUs_.pop_front();
      } else {
        int64_t tsNs = 0;
        AImage_getTimestamp(image, &tsNs);
        ptsUs = tsNs / 1000;
      }
    }
    DecodedRawFrame fr;
    auto st = CopyImageToFrame(image, &fr, ptsUs);
    AImage_delete(image);
    if (!st.ok || fr.view.y.data == nullptr) {
      VIDEO_LOGW("video.decode amc copy failed ptsUs=%lld",
                 static_cast<long long>(ptsUs));
      continue;
    }
    {
      std::lock_guard<std::mutex> lock(outMu_);
      out_.push_back(std::move(fr));
    }
    VIDEO_LOGI("video.decode amc image ptsUs=%lld",
               static_cast<long long>(ptsUs));
    outCv_.notify_one();
  }
}

bool AMediaCodecDecoder::PopDecoded(DecodedRawFrame* out) {
  if (out == nullptr) {
    return false;
  }
  std::lock_guard<std::mutex> lock(outMu_);
  if (out_.empty()) {
    return false;
  }
  *out = std::move(out_.front());
  out_.pop_front();
  return out->view.y.data != nullptr;
}

bool AMediaCodecDecoder::Receive(DecodedRawFrame* out) {
  PumpCodec(0);
  DrainImages();
  return PopDecoded(out);
}

bool AMediaCodecDecoder::ReceiveWait(DecodedRawFrame* out, int64_t timeoutUs) {
  if (out == nullptr) {
    return false;
  }
  if (timeoutUs < 0) {
    timeoutUs = 0;
  }
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::microseconds(timeoutUs);
  for (;;) {
    PumpCodec(0);
    DrainImages();
    if (PopDecoded(out)) {
      return true;
    }
    auto now = std::chrono::steady_clock::now();
    if (now >= deadline) {
      PumpCodec(0);
      DrainImages();
      return PopDecoded(out);
    }
    const auto remainUs = std::chrono::duration_cast<std::chrono::microseconds>(
                              deadline - now)
                              .count();
    const int64_t codecWait =
        remainUs > 20000 ? 20000 : static_cast<int64_t>(remainUs);
    PumpCodec(codecWait);
    DrainImages();
    if (PopDecoded(out)) {
      return true;
    }
    now = std::chrono::steady_clock::now();
    if (now >= deadline) {
      return false;
    }
    const auto waitLeft = std::chrono::duration_cast<std::chrono::microseconds>(
        deadline - now);
    std::unique_lock<std::mutex> lock(outMu_);
    if (!out_.empty()) {
      *out = std::move(out_.front());
      out_.pop_front();
      return out->view.y.data != nullptr;
    }
    outCv_.wait_for(lock, waitLeft);
    if (!out_.empty()) {
      *out = std::move(out_.front());
      out_.pop_front();
      return out->view.y.data != nullptr;
    }
  }
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
  imageGen_.fetch_add(1);
  if (reader_) {
    AImageReader_setImageListener(reader_, nullptr);
  }
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
  {
    std::lock_guard<std::mutex> lock(outMu_);
    pendingPtsUs_.clear();
    out_.clear();
  }
  queuedSinceStart_ = false;
  configured_ = false;
}

}  // namespace video
}  // namespace sherpa_onnx

#endif
