#import "VideoToolboxDecoder.h"

#import "VideoLog.h"
#import "demux/BitstreamUtil.h"

#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <VideoToolbox/VideoToolbox.h>

#include <deque>
#include <mutex>
#include <vector>

namespace sherpa_onnx {
namespace video {
namespace {

void DecodeCallback(void* refcon, void* /*sourceFrameRefCon*/, OSStatus status,
                    VTDecodeInfoFlags /*infoFlags*/, CVImageBufferRef image,
                    CMTime pts, CMTime /*duration*/) {
  auto* self = static_cast<VideoToolboxDecoder*>(refcon);
  if (status != noErr || image == nullptr || self == nullptr) {
    return;
  }
  CVPixelBufferRef pix = (CVPixelBufferRef)image;
  CVPixelBufferLockBaseAddress(pix, kCVPixelBufferLock_ReadOnly);
  const int w = (int)CVPixelBufferGetWidth(pix);
  const int h = (int)CVPixelBufferGetHeight(pix);
  uint8_t* y = (uint8_t*)CVPixelBufferGetBaseAddressOfPlane(pix, 0);
  uint8_t* uv = (uint8_t*)CVPixelBufferGetBaseAddressOfPlane(pix, 1);
  const int ys = (int)CVPixelBufferGetBytesPerRowOfPlane(pix, 0);
  const int uvs = (int)CVPixelBufferGetBytesPerRowOfPlane(pix, 1);
  DecodedRawFrame fr;
  const int dy = AlignUp(w);
  const int duv = AlignUp(w);
  const size_t bytes =
      (size_t)dy * h + (size_t)duv * ((h + 1) / 2);
  if (!fr.storage.Allocate(bytes).ok) {
    CVPixelBufferUnlockBaseAddress(pix, kCVPixelBufferLock_ReadOnly);
    return;
  }
  uint8_t* dstY = fr.storage.data();
  uint8_t* dstUv = dstY + (size_t)dy * h;
  for (int r = 0; r < h; ++r) {
    memcpy(dstY + (size_t)r * dy, y + (size_t)r * ys, (size_t)w);
  }
  const int ch = (h + 1) / 2;
  for (int r = 0; r < ch; ++r) {
    memcpy(dstUv + (size_t)r * duv, uv + (size_t)r * uvs, (size_t)w);
  }
  fr.view.y.data = dstY;
  fr.view.y.stride = dy;
  fr.view.uv.data = dstUv;
  fr.view.uv.stride = duv;
  fr.view.width = w;
  fr.view.height = h;
  fr.ptsUs = CMTIME_IS_VALID(pts) ? (int64_t)(CMTimeGetSeconds(pts) * 1e6) : 0;
  self->PushDecoded(std::move(fr));
  CVPixelBufferUnlockBaseAddress(pix, kCVPixelBufferLock_ReadOnly);
}

}  // namespace

VideoToolboxDecoder::VideoToolboxDecoder() : VideoToolboxDecoder(Mode::Hardware) {}
VideoToolboxDecoder::VideoToolboxDecoder(Mode mode) : mode_(mode) {}
VideoToolboxDecoder::~VideoToolboxDecoder() { Close(); }

Status VideoToolboxDecoder::Configure(const VideoTrackInfo& track) {
  Close();
  track_ = track;
  const CMVideoCodecType codecType = track.codec == VideoCodec::Hevc
                                         ? kCMVideoCodecType_HEVC
                                         : kCMVideoCodecType_H264;
  if (mode_ == Mode::Hardware &&
      !VTIsHardwareDecodeSupported(codecType)) {
    if (@available(iOS 17.0, *)) {
      return Status::Fail(kErrDecoderUnavailable, "VT hardware not supported");
    }
    // iOS < 17: hardware provider is legacy create, reported unknown.
  }
  if (mode_ == Mode::Software) {
    if (@available(iOS 17.0, *)) {
    } else {
      return Status::Fail(kErrSwDecoderDisabled, "os-too-old");
    }
  }
  std::vector<std::vector<uint8_t>> sps, pps, vps;
  OSStatus err = noErr;
  CMVideoFormatDescriptionRef fmt = nullptr;
  if (track.codec == VideoCodec::H264) {
    auto st = BitstreamUtil::ExtractH264ParameterSets(track.codecConfig, &sps, &pps);
    if (!st.ok || sps.empty() || pps.empty()) {
      return Status::Fail(kErrCodecUnsupported, "avcC");
    }
    const uint8_t* setPtrs[2] = {sps[0].data(), pps[0].data()};
    size_t setSizes[2] = {sps[0].size(), pps[0].size()};
    err = CMVideoFormatDescriptionCreateFromH264ParameterSets(
        kCFAllocatorDefault, 2, setPtrs, setSizes, 4, &fmt);
  } else {
    auto st = BitstreamUtil::ExtractHevcParameterSets(track.codecConfig, &vps,
                                                      &sps, &pps);
    if (!st.ok || sps.empty()) {
      return Status::Fail(kErrCodecUnsupported, "hvcC");
    }
    std::vector<const uint8_t*> ptrs;
    std::vector<size_t> sizes;
    if (!vps.empty()) {
      ptrs.push_back(vps[0].data());
      sizes.push_back(vps[0].size());
    }
    ptrs.push_back(sps[0].data());
    sizes.push_back(sps[0].size());
    if (!pps.empty()) {
      ptrs.push_back(pps[0].data());
      sizes.push_back(pps[0].size());
    }
    err = CMVideoFormatDescriptionCreateFromHEVCParameterSets(
        kCFAllocatorDefault, ptrs.size(), ptrs.data(), sizes.data(), 4, nullptr,
        &fmt);
  }
  if (err != noErr || fmt == nullptr) {
    return Status::Fail(kErrDecoderUnavailable, "format desc");
  }
  format_ = fmt;
  VTDecompressionOutputCallbackRecord cb = {DecodeCallback, this};
  CFMutableDictionaryRef attrs = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 1, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  int32_t pix = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
  CFNumberRef pixNum =
      CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &pix);
  CFDictionarySetValue(attrs, kCVPixelBufferPixelFormatTypeKey, pixNum);
  CFRelease(pixNum);
  CFMutableDictionaryRef spec = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 1, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
#if defined(__IPHONE_17_0)
  if (@available(iOS 17.0, *)) {
    if (mode_ == Mode::Hardware) {
      CFDictionarySetValue(
          spec, kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder,
          kCFBooleanTrue);
    } else {
      CFDictionarySetValue(
          spec, kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder,
          kCFBooleanFalse);
    }
  }
#endif
  VTDecompressionSessionRef session = nullptr;
  err = VTDecompressionSessionCreate(kCFAllocatorDefault, fmt, spec, attrs,
                                     &cb, &session);
  CFRelease(spec);
  CFRelease(attrs);
  if (err != noErr || session == nullptr) {
    CFRelease(fmt);
    format_ = nullptr;
    return Status::Fail(kErrDecoderUnavailable, "VT session");
  }
  session_ = session;
  configured_ = true;
  VIDEO_LOGI("video.decode vt %s", VideoCodecName(track.codec));
#if defined(__IPHONE_17_0)
  if (@available(iOS 17.0, *)) {
    CFTypeRef used = nullptr;
    const OSStatus pst = VTSessionCopyProperty(
        session, kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
        kCFAllocatorDefault, &used);
    int hw = -1;
    if (pst == noErr && used != nullptr) {
      hw = (used == kCFBooleanTrue) ? 1 : 0;
      CFRelease(used);
    }
    VIDEO_LOGI("codec.vt decode hw=%d", hw);
    usedHardware_ = hw == 1;
  }
#endif
  return Status::Ok();
}

Status VideoToolboxDecoder::Submit(const EncodedPacket& packet) {
  if (!configured_ || session_ == nullptr || format_ == nullptr) {
    return Status::Fail(kErrDecoderUnavailable, "vt");
  }
  CMBlockBufferRef block = nullptr;
  OSStatus err = CMBlockBufferCreateWithMemoryBlock(
      kCFAllocatorDefault, (void*)packet.payload.data(), packet.payload.size(),
      kCFAllocatorNull, nullptr, 0, packet.payload.size(), 0, &block);
  if (err != noErr) {
    return Status::Fail(kErrDecodeFailed, "block");
  }
  CMSampleBufferRef sample = nullptr;
  const size_t sampleSize = packet.payload.size();
  CMSampleTimingInfo timing;
  timing.duration = kCMTimeInvalid;
  timing.presentationTimeStamp = CMTimeMake(packet.ptsUs, 1000000);
  timing.decodeTimeStamp = CMTimeMake(packet.dtsUs, 1000000);
  err = CMSampleBufferCreateReady(kCFAllocatorDefault, block,
                                  (CMFormatDescriptionRef)format_, 1,
                                  1, &timing, 1, &sampleSize, &sample);
  CFRelease(block);
  if (err != noErr) {
    return Status::Fail(kErrDecodeFailed, "sample");
  }
  VTDecodeFrameFlags flags = kVTDecodeFrame_EnableAsynchronousDecompression;
  err = VTDecompressionSessionDecodeFrame((VTDecompressionSessionRef)session_,
                                          sample, flags, nullptr, nullptr);
  CFRelease(sample);
  if (err == kVTInvalidSessionErr) {
    return Status::Fail("invalid-session", "vt session");
  }
  if (err != noErr) {
    return Status::Fail(kErrDecodeFailed, "decode");
  }
  ++submitCount_;
  return Status::Ok();
}

Status VideoToolboxDecoder::Flush() {
  if (session_) {
    VTDecompressionSessionWaitForAsynchronousFrames(
        (VTDecompressionSessionRef)session_);
  }
  ++flushCount_;
  return Status::Ok();
}

void VideoToolboxDecoder::PushDecoded(DecodedRawFrame fr) {
  std::lock_guard<std::mutex> lock(outMu_);
  out_.push_back(std::move(fr));
}

bool VideoToolboxDecoder::Receive(DecodedRawFrame* out) {
  if (out == nullptr) {
    return false;
  }
  std::lock_guard<std::mutex> lock(outMu_);
  if (out_.empty()) {
    return false;
  }
  *out = std::move(out_.front());
  out_.pop_front();
  return true;
}

bool VideoToolboxDecoder::ReceiveWait(DecodedRawFrame* out, int64_t timeoutUs) {
  (void)timeoutUs;
  if (Receive(out)) {
    return true;
  }
  if (session_) {
    VTDecompressionSessionWaitForAsynchronousFrames(
        (VTDecompressionSessionRef)session_);
  }
  return Receive(out);
}

void VideoToolboxDecoder::Close() {
  if (session_) {
    VTDecompressionSessionInvalidate((VTDecompressionSessionRef)session_);
    CFRelease((VTDecompressionSessionRef)session_);
    session_ = nullptr;
  }
  if (format_) {
    CFRelease((CMVideoFormatDescriptionRef)format_);
    format_ = nullptr;
  }
  configured_ = false;
}

}  // namespace video
}  // namespace sherpa_onnx
