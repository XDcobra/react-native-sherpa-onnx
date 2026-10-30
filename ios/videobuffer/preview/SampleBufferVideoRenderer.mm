#import "SampleBufferVideoRenderer.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <VideoToolbox/VideoToolbox.h>

#include "VideoLog.h"
#include "demux/BitstreamUtil.h"

namespace sherpa_onnx {
namespace video {
namespace preview {

SampleBufferVideoRenderer::SampleBufferVideoRenderer() = default;
SampleBufferVideoRenderer::~SampleBufferVideoRenderer() { Close(); }

void SampleBufferVideoRenderer::SetLayer(void* layer) { layer_ = layer; }

Status SampleBufferVideoRenderer::Configure(const VideoTrackInfo& track) {
  Close();
  track_ = track;
  const CMVideoCodecType codecType =
      track.codec == VideoCodec::Hevc ? kCMVideoCodecType_HEVC
                                      : kCMVideoCodecType_H264;
  if (!VTIsHardwareDecodeSupported(codecType)) {
    return Status::Fail(kErrDecoderUnavailable, "no HW video decode");
  }
  std::vector<std::vector<uint8_t>> sps, pps, vps;
  CMFormatDescriptionRef fmt = nullptr;
  OSStatus os = -1;
  if (track.codec == VideoCodec::Hevc) {
    BitstreamUtil::ExtractHevcParameterSets(track.codecConfig, &vps, &sps, &pps);
    if (vps.empty() || sps.empty() || pps.empty()) {
      return Status::Fail(kErrCodecUnsupported, "hevc params");
    }
    const uint8_t* pVps = vps[0].data();
    const uint8_t* pSps = sps[0].data();
    const uint8_t* pPps = pps[0].data();
    size_t nVps = vps[0].size(), nSps = sps[0].size(), nPps = pps[0].size();
    const uint8_t* params[3] = {pVps, pSps, pPps};
    size_t sizes[3] = {nVps, nSps, nPps};
    os = CMVideoFormatDescriptionCreateFromHEVCParameterSets(
        kCFAllocatorDefault, 3, params, sizes, 4, nullptr, &fmt);
  } else {
    BitstreamUtil::ExtractH264ParameterSets(track.codecConfig, &sps, &pps);
    if (sps.empty() || pps.empty()) {
      return Status::Fail(kErrCodecUnsupported, "avc params");
    }
    const uint8_t* pSps = sps[0].data();
    const uint8_t* pPps = pps[0].data();
    size_t nSps = sps[0].size(), nPps = pps[0].size();
    const uint8_t* params[2] = {pSps, pPps};
    size_t sizes[2] = {nSps, nPps};
    os = CMVideoFormatDescriptionCreateFromH264ParameterSets(
        kCFAllocatorDefault, 2, params, sizes, 4, &fmt);
  }
  if (os != noErr || fmt == nullptr) {
    return Status::Fail(kErrDecoderUnavailable, "format desc");
  }
  formatDesc_ = fmt;
  firstShown_ = false;
  VIDEO_LOGI("video.preview ios format %dx%d", track.codedWidth, track.codedHeight);
  return Status::Ok();
}

Status SampleBufferVideoRenderer::Submit(const EncodedPacket& pkt, bool displayFlag,
                                         uint64_t gen) {
  gen_ = gen;
  auto* layer = (__bridge AVSampleBufferDisplayLayer*)layer_;
  CMFormatDescriptionRef fmt = (CMFormatDescriptionRef)formatDesc_;
  if (layer == nil || fmt == nullptr || pkt.payload.empty()) {
    return Status::Ok();
  }
  CMBlockBufferRef block = nullptr;
  OSStatus os = CMBlockBufferCreateWithMemoryBlock(
      kCFAllocatorDefault, const_cast<uint8_t*>(pkt.payload.data()),
      pkt.payload.size(), kCFAllocatorNull, nullptr, 0, pkt.payload.size(), 0,
      &block);
  if (os != noErr || block == nullptr) {
    return Status::Fail(kErrPreviewRenderFailed, "block");
  }
  CMSampleBufferRef sample = nullptr;
  const size_t one = pkt.payload.size();
  CMSampleTimingInfo timing;
  timing.duration = CMTimeMake(1, 30);
  timing.presentationTimeStamp = CMTimeMake(pkt.ptsUs, 1000000);
  timing.decodeTimeStamp = kCMTimeInvalid;
  os = CMSampleBufferCreateReady(kCFAllocatorDefault, block, fmt, 1, 1, &timing,
                                 1, &one, &sample);
  CFRelease(block);
  if (os != noErr || sample == nullptr) {
    return Status::Fail(kErrPreviewRenderFailed, "sample");
  }
  if (!displayFlag) {
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, true);
    if (attachments && CFArrayGetCount(attachments) > 0) {
      CFMutableDictionaryRef dict = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(
          attachments, 0);
      CFDictionarySetValue(dict, kCMSampleAttachmentKey_DoNotDisplay,
                           kCFBooleanTrue);
    }
  }
  if (@available(iOS 17.0, macOS 14.0, *)) {
    [layer.sampleBufferRenderer enqueueSampleBuffer:sample];
  } else {
    [layer enqueueSampleBuffer:sample];
  }
  CFRelease(sample);
  if (displayFlag) {
    ++stats_.rendered;
    if (!firstShown_) {
      firstShown_ = true;
      if (onFirstFrameShown) onFirstFrameShown(gen_, pkt.ptsUs);
    }
    if (onFrameShown) onFrameShown(gen_, pkt.ptsUs);
  }
  return Status::Ok();
}

bool SampleBufferVideoRenderer::ReadyForMore() const {
  auto* layer = (__bridge AVSampleBufferDisplayLayer*)layer_;
  if (layer == nil) return false;
  if (@available(iOS 17.0, macOS 14.0, *)) {
    return layer.sampleBufferRenderer.isReadyForMoreMediaData;
  }
  return layer.readyForMoreMediaData;
}

void SampleBufferVideoRenderer::Flush(uint64_t gen) {
  gen_ = gen;
  firstShown_ = false;
  auto* layer = (__bridge AVSampleBufferDisplayLayer*)layer_;
  if (layer == nil) return;
  if (@available(iOS 17.0, macOS 14.0, *)) {
    [layer.sampleBufferRenderer flush];
  } else {
    [layer flush];
  }
}

void SampleBufferVideoRenderer::SignalEos(uint64_t gen) {
  gen_ = gen;
  if (onEos) onEos(gen_);
}

void SampleBufferVideoRenderer::Close() {
  if (formatDesc_) {
    CFRelease((CMFormatDescriptionRef)formatDesc_);
    formatDesc_ = nullptr;
  }
}

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
