#import "VideoToolboxEncoder.h"

#import "VideoLog.h"

#import <Foundation/Foundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <VideoToolbox/VideoToolbox.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <vector>

namespace sherpa_onnx {
namespace video {

namespace {

int FpsFromTrack(const VideoTrackInfo& track) {
  if (track.nominalFps.num > 0 && track.nominalFps.den > 0) {
    const int fps =
        (track.nominalFps.num + track.nominalFps.den / 2) / track.nominalFps.den;
    return std::max(1, fps);
  }
  return 30;
}

std::vector<uint8_t> CopyBlockBuffer(CMSampleBufferRef sample) {
  std::vector<uint8_t> out;
  CMBlockBufferRef bb = CMSampleBufferGetDataBuffer(sample);
  if (!bb) {
    return out;
  }
  size_t total = CMBlockBufferGetDataLength(bb);
  if (total == 0) {
    return out;
  }
  out.resize(total);
  size_t copied = 0;
  OSStatus st =
      CMBlockBufferCopyDataBytes(bb, 0, total, out.data());
  if (st != noErr) {
    out.clear();
    (void)copied;
  }
  return out;
}

std::vector<uint8_t> ExtractAvcc(CMSampleBufferRef sample, VideoCodec codec) {
  CMFormatDescriptionRef desc = CMSampleBufferGetFormatDescription(sample);
  if (!desc) {
    return {};
  }
  CFStringRef key = codec == VideoCodec::Hevc ? CFSTR("hvcC") : CFSTR("avcC");
  CFDictionaryRef atoms = static_cast<CFDictionaryRef>(
      CMFormatDescriptionGetExtension(
          desc, kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms));
  if (!atoms) {
    return {};
  }
  CFDataRef data = static_cast<CFDataRef>(CFDictionaryGetValue(atoms, key));
  if (!data) {
    return {};
  }
  const UInt8* ptr = CFDataGetBytePtr(data);
  const CFIndex len = CFDataGetLength(data);
  if (!ptr || len <= 0) {
    return {};
  }
  return std::vector<uint8_t>(ptr, ptr + len);
}

bool SampleIsKey(CMSampleBufferRef sample) {
  CFArrayRef atts = CMSampleBufferGetSampleAttachmentsArray(sample, false);
  if (!atts || CFArrayGetCount(atts) == 0) {
    return true;
  }
  CFDictionaryRef d =
      static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(atts, 0));
  if (!d) {
    return true;
  }
  CFBooleanRef notSync = static_cast<CFBooleanRef>(
      CFDictionaryGetValue(d, kCMSampleAttachmentKey_NotSync));
  if (notSync == kCFBooleanTrue) {
    return false;
  }
  CFBooleanRef depends = static_cast<CFBooleanRef>(
      CFDictionaryGetValue(d, kCMSampleAttachmentKey_DependsOnOthers));
  if (depends == kCFBooleanTrue) {
    return false;
  }
  return true;
}

}  // namespace

struct VideoToolboxEncoder::Impl {
  VTCompressionSessionRef session = nullptr;
  std::mutex mu;
  std::condition_variable cv;
  std::vector<EncodedPacket> queue;
  std::vector<uint8_t> codecConfig;
  int inFlight = 0;
  bool failed = false;
  int width = 0;
  int height = 0;
  int fps = 30;
  VideoCodec codec = VideoCodec::H264;

  static void Callback(void* outputCallbackRefCon, void* /*sourceFrameRefCon*/,
                       OSStatus status, VTEncodeInfoFlags /*infoFlags*/,
                       CMSampleBufferRef sampleBuffer) {
    auto* impl = static_cast<Impl*>(outputCallbackRefCon);
    std::lock_guard<std::mutex> lock(impl->mu);
    impl->inFlight = std::max(0, impl->inFlight - 1);
    if (status != noErr || sampleBuffer == nullptr) {
      impl->failed = true;
      impl->cv.notify_all();
      return;
    }
    if (impl->codecConfig.empty()) {
      impl->codecConfig = ExtractAvcc(sampleBuffer, impl->codec);
    }
    EncodedPacket pkt;
    pkt.payload = CopyBlockBuffer(sampleBuffer);
    const CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    if (CMTIME_IS_VALID(pts) && pts.timescale > 0) {
      pkt.ptsUs = pts.value * 1000000LL / pts.timescale;
    }
    pkt.dtsUs = pkt.ptsUs;
    if (SampleIsKey(sampleBuffer)) {
      pkt.flags = kSampleKey;
    }
    if (!pkt.payload.empty()) {
      impl->queue.push_back(std::move(pkt));
    }
    impl->cv.notify_all();
  }

  void DrainLocked(std::vector<EncodedPacket>* out) {
    if (out) {
      out->insert(out->end(), queue.begin(), queue.end());
    }
    queue.clear();
  }
};

VideoToolboxEncoder::VideoToolboxEncoder()
    : VideoToolboxEncoder(Mode::Hardware) {}
VideoToolboxEncoder::VideoToolboxEncoder(Mode mode) : mode_(mode) {}
VideoToolboxEncoder::~VideoToolboxEncoder() { Close(); }

Status VideoToolboxEncoder::Configure(const VideoTrackInfo& track, int bitrate) {
  Close();
  if (track.codedWidth <= 0 || track.codedHeight <= 0) {
    return Status::Fail(kErrInvalidArgument, "encoder size");
  }
  impl_ = std::make_unique<Impl>();
  impl_->width = track.codedWidth;
  impl_->height = track.codedHeight;
  impl_->codec = track.codec;
  impl_->fps = FpsFromTrack(track);

  CMVideoCodecType codecType = track.codec == VideoCodec::Hevc
                                   ? kCMVideoCodecType_HEVC
                                   : kCMVideoCodecType_H264;
  CFMutableDictionaryRef spec = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 1, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
#if defined(__IPHONE_17_4)
  if (@available(iOS 17.4, *)) {
    if (mode_ == Mode::Hardware) {
      CFDictionarySetValue(
          spec,
          kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder,
          kCFBooleanTrue);
    } else {
      CFDictionarySetValue(
          spec,
          kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder,
          kCFBooleanFalse);
    }
  }
#endif
  VTCompressionSessionRef session = nullptr;
  OSStatus st = VTCompressionSessionCreate(
      kCFAllocatorDefault, track.codedWidth, track.codedHeight, codecType,
      spec, nullptr, nullptr, &Impl::Callback, impl_.get(), &session);
  CFRelease(spec);
  if (st != noErr || session == nullptr) {
    impl_.reset();
    return Status::Fail(kErrEncoderUnavailable, "VTCompressionSessionCreate");
  }
  impl_->session = session;

  const int br = bitrate > 0 ? bitrate : 2'000'000;
  CFNumberRef brNum =
      CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &br);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_AverageBitRate, brNum);
  CFRelease(brNum);

  const int fps = impl_->fps;
  CFNumberRef fpsNum =
      CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &fps);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_ExpectedFrameRate,
                       fpsNum);
  CFRelease(fpsNum);

  VTSessionSetProperty(session, kVTCompressionPropertyKey_AllowFrameReordering,
                       kCFBooleanFalse);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_RealTime,
                       kCFBooleanFalse);
  if (track.codec == VideoCodec::Hevc) {
    VTSessionSetProperty(session, kVTCompressionPropertyKey_ProfileLevel,
                         kVTProfileLevel_HEVC_Main_AutoLevel);
  } else {
    VTSessionSetProperty(session, kVTCompressionPropertyKey_ProfileLevel,
                         kVTProfileLevel_H264_Baseline_AutoLevel);
  }
  const int gop = fps;
  CFNumberRef gopNum =
      CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &gop);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_MaxKeyFrameInterval,
                       gopNum);
  CFRelease(gopNum);
  VTCompressionSessionPrepareToEncodeFrames(session);
  VIDEO_LOGI("video.encode vt %dx%d fps=%d bitrate=%d", track.codedWidth,
             track.codedHeight, fps, br);
#if defined(__IPHONE_17_4)
  if (@available(iOS 17.4, *)) {
    CFTypeRef used = nullptr;
    const OSStatus pst = VTSessionCopyProperty(
        session, kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
        kCFAllocatorDefault, &used);
    int hw = -1;
    if (pst == noErr && used != nullptr) {
      hw = (used == kCFBooleanTrue) ? 1 : 0;
      CFRelease(used);
    }
    VIDEO_LOGI("codec.vt encode hw=%d", hw);
  }
#endif
  return Status::Ok();
}

Status VideoToolboxEncoder::Encode(const RawFrame& frame,
                                   std::vector<EncodedPacket>* out) {
  if (!impl_ || !impl_->session || out == nullptr) {
    return Status::Fail(kErrEncoderUnavailable, "vt encoder");
  }
  if (frame.nv12.width != impl_->width || frame.nv12.height != impl_->height ||
      frame.nv12.y.data == nullptr || frame.nv12.uv.data == nullptr) {
    return Status::Fail(kErrInvalidArgument, "vt nv12 size");
  }

  NSDictionary* attrs = @{
    (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
  };
  CVPixelBufferRef pb = nullptr;
  CVReturn cv = CVPixelBufferCreate(
      kCFAllocatorDefault, impl_->width, impl_->height,
      kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      (__bridge CFDictionaryRef)attrs, &pb);
  if (cv != kCVReturnSuccess || pb == nullptr) {
    return Status::Fail(kErrEncodeFailed, "CVPixelBufferCreate");
  }
  CVPixelBufferLockBaseAddress(pb, 0);
  uint8_t* yDst = static_cast<uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(pb, 0));
  uint8_t* uvDst =
      static_cast<uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(pb, 1));
  const size_t yStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0);
  const size_t uvStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 1);
  for (int row = 0; row < impl_->height; ++row) {
    std::memcpy(yDst + static_cast<size_t>(row) * yStride,
                frame.nv12.y.data +
                    static_cast<size_t>(row) *
                        static_cast<size_t>(frame.nv12.y.stride),
                static_cast<size_t>(impl_->width));
  }
  const int uvH = (impl_->height + 1) / 2;
  for (int row = 0; row < uvH; ++row) {
    std::memcpy(uvDst + static_cast<size_t>(row) * uvStride,
                frame.nv12.uv.data +
                    static_cast<size_t>(row) *
                        static_cast<size_t>(frame.nv12.uv.stride),
                static_cast<size_t>(impl_->width));
  }
  CVPixelBufferUnlockBaseAddress(pb, 0);

  CMTime pts = CMTimeMake(frame.ptsUs, 1000000);
  {
    std::lock_guard<std::mutex> lock(impl_->mu);
    impl_->inFlight++;
  }
  OSStatus st = VTCompressionSessionEncodeFrame(impl_->session, pb, pts,
                                                kCMTimeInvalid, nullptr,
                                                nullptr, nullptr);
  CVPixelBufferRelease(pb);
  if (st != noErr) {
    std::lock_guard<std::mutex> lock(impl_->mu);
    impl_->inFlight = std::max(0, impl_->inFlight - 1);
    return Status::Fail(kErrEncodeFailed, "VTCompressionSessionEncodeFrame");
  }

  std::unique_lock<std::mutex> lock(impl_->mu);
  impl_->cv.wait_for(lock, std::chrono::milliseconds(2000), [&] {
    return impl_->inFlight == 0 || impl_->failed;
  });
  if (impl_->failed) {
    return Status::Fail(kErrEncodeFailed, "vt callback");
  }
  impl_->DrainLocked(out);
  return Status::Ok();
}

Status VideoToolboxEncoder::Flush(std::vector<EncodedPacket>* out) {
  if (!impl_ || !impl_->session || out == nullptr) {
    return Status::Fail(kErrEncoderUnavailable, "vt flush");
  }
  OSStatus st =
      VTCompressionSessionCompleteFrames(impl_->session, kCMTimeInvalid);
  if (st != noErr) {
    return Status::Fail(kErrEncodeFailed, "VTCompressionSessionCompleteFrames");
  }
  std::unique_lock<std::mutex> lock(impl_->mu);
  impl_->cv.wait_for(lock, std::chrono::milliseconds(4000), [&] {
    return impl_->inFlight == 0 || impl_->failed;
  });
  if (impl_->failed) {
    return Status::Fail(kErrEncodeFailed, "vt flush callback");
  }
  impl_->DrainLocked(out);
  return Status::Ok();
}

void VideoToolboxEncoder::Close() {
  if (!impl_) {
    return;
  }
  if (impl_->session) {
    VTCompressionSessionInvalidate(impl_->session);
    CFRelease(impl_->session);
    impl_->session = nullptr;
  }
  impl_.reset();
}

std::vector<uint8_t> VideoToolboxEncoder::CodecConfig() const {
  if (!impl_) {
    return {};
  }
  std::lock_guard<std::mutex> lock(impl_->mu);
  return impl_->codecConfig;
}

}  // namespace video
}  // namespace sherpa_onnx
