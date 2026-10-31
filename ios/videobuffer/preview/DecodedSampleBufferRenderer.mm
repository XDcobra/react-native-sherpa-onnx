#import "DecodedSampleBufferRenderer.h"

#import "VideoLog.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreVideo/CoreVideo.h>

#include <cstring>

namespace sherpa_onnx {
namespace video {
namespace preview {

DecodedSampleBufferRenderer::DecodedSampleBufferRenderer() = default;
DecodedSampleBufferRenderer::~DecodedSampleBufferRenderer() { Close(); }

void DecodedSampleBufferRenderer::SetLayer(void* layer) { layer_ = layer; }

void DecodedSampleBufferRenderer::SetDecoder(
    std::shared_ptr<DecoderBackend> decoder) {
  decoder_ = std::move(decoder);
}

Status DecodedSampleBufferRenderer::Configure(const VideoTrackInfo& track) {
  track_ = track;
  if (pool_) {
    CVPixelBufferPoolRelease((CVPixelBufferPoolRef)pool_);
    pool_ = nullptr;
  }
  NSDictionary* attrs = @{
    (id)kCVPixelBufferPixelFormatTypeKey :
        @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
    (id)kCVPixelBufferWidthKey : @(track.codedWidth),
    (id)kCVPixelBufferHeightKey : @(track.codedHeight),
    (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
  };
  CVPixelBufferPoolRef pool = nullptr;
  const CVReturn rc = CVPixelBufferPoolCreate(
      kCFAllocatorDefault, nullptr, (__bridge CFDictionaryRef)attrs, &pool);
  if (rc != kCVReturnSuccess || pool == nullptr) {
    return Status::Fail(kErrPreviewRenderFailed, "pixel pool");
  }
  pool_ = pool;
  if (decoder_) {
    auto st = decoder_->Configure(track);
    if (!st.ok) return st;
  }
  VIDEO_LOGI("video.preview decoded-sbuf %dx%d", track.codedWidth,
             track.codedHeight);
  return Status::Ok();
}

Status DecodedSampleBufferRenderer::EnqueueFrame(const DecodedRawFrame& fr) {
  if (layer_ == nullptr || pool_ == nullptr) {
    return Status::Fail(kErrPreviewRenderFailed, "layer");
  }
  CVPixelBufferRef pix = nullptr;
  const CVReturn rc = CVPixelBufferPoolCreatePixelBuffer(
      kCFAllocatorDefault, (CVPixelBufferPoolRef)pool_, &pix);
  if (rc != kCVReturnSuccess || pix == nullptr) {
    return Status::Fail(kErrPreviewRenderFailed, "pixel");
  }
  CVPixelBufferLockBaseAddress(pix, 0);
  uint8_t* y = (uint8_t*)CVPixelBufferGetBaseAddressOfPlane(pix, 0);
  uint8_t* uv = (uint8_t*)CVPixelBufferGetBaseAddressOfPlane(pix, 1);
  const int ys = (int)CVPixelBufferGetBytesPerRowOfPlane(pix, 0);
  const int uvs = (int)CVPixelBufferGetBytesPerRowOfPlane(pix, 1);
  const int w = fr.view.width;
  const int h = fr.view.height;
  for (int r = 0; r < h; ++r) {
    memcpy(y + (size_t)r * ys, fr.view.y.data + (size_t)r * fr.view.y.stride,
           (size_t)w);
  }
  const int ch = (h + 1) / 2;
  for (int r = 0; r < ch; ++r) {
    memcpy(uv + (size_t)r * uvs,
           fr.view.uv.data + (size_t)r * fr.view.uv.stride, (size_t)w);
  }
  CVPixelBufferUnlockBaseAddress(pix, 0);

  CMVideoFormatDescriptionRef fmt = nullptr;
  OSStatus err = CMVideoFormatDescriptionCreateForImageBuffer(
      kCFAllocatorDefault, pix, &fmt);
  if (err != noErr || fmt == nullptr) {
    CVPixelBufferRelease(pix);
    return Status::Fail(kErrPreviewRenderFailed, "format");
  }
  CMSampleTimingInfo timing;
  timing.duration = kCMTimeInvalid;
  timing.presentationTimeStamp = CMTimeMake(fr.ptsUs, 1000000);
  timing.decodeTimeStamp = kCMTimeInvalid;
  CMSampleBufferRef sample = nullptr;
  err = CMSampleBufferCreateReadyWithImageBuffer(
      kCFAllocatorDefault, pix, fmt, &timing, &sample);
  CFRelease(fmt);
  CVPixelBufferRelease(pix);
  if (err != noErr || sample == nullptr) {
    return Status::Fail(kErrPreviewRenderFailed, "sample");
  }
  AVSampleBufferDisplayLayer* layer =
      (__bridge AVSampleBufferDisplayLayer*)layer_;
  [layer enqueueSampleBuffer:sample];
  CFRelease(sample);
  ++stats_.rendered;
  if (!firstShown_) {
    firstShown_ = true;
    if (onFirstFrameShown) onFirstFrameShown(gen_, fr.ptsUs);
  }
  if (onFrameShown) onFrameShown(gen_, fr.ptsUs);
  return Status::Ok();
}

Status DecodedSampleBufferRenderer::Submit(const EncodedPacket& pkt,
                                           bool displayFlag, uint64_t gen) {
  gen_ = gen;
  if (!decoder_) {
    return Status::Fail(kErrPreviewRenderFailed, "no decoder");
  }
  auto st = decoder_->Submit(pkt);
  if (!st.ok) return st;
  DecodedRawFrame fr;
  while (decoder_->Receive(&fr)) {
    if (displayFlag) {
      st = EnqueueFrame(fr);
      if (!st.ok) return st;
    }
  }
  return Status::Ok();
}

bool DecodedSampleBufferRenderer::ReadyForMore() const { return true; }

void DecodedSampleBufferRenderer::Flush(uint64_t gen) {
  gen_ = gen;
  firstShown_ = false;
  if (decoder_) decoder_->Flush();
  AVSampleBufferDisplayLayer* layer =
      (__bridge AVSampleBufferDisplayLayer*)layer_;
  [layer flush];
}

void DecodedSampleBufferRenderer::SignalEos(uint64_t gen) {
  if (onEos) onEos(gen);
}

void DecodedSampleBufferRenderer::Close() {
  if (pool_) {
    CVPixelBufferPoolRelease((CVPixelBufferPoolRef)pool_);
    pool_ = nullptr;
  }
  if (decoder_) decoder_->Close();
  layer_ = nullptr;
}

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
