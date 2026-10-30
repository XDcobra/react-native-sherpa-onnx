#import "SampleBufferAudioRenderer.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>

#include "VideoLog.h"

#include <cstring>
#include <cstdlib>

namespace sherpa_onnx {
namespace video {
namespace preview {

SampleBufferAudioRenderer::SampleBufferAudioRenderer() = default;
SampleBufferAudioRenderer::~SampleBufferAudioRenderer() { Close(); }

Status SampleBufferAudioRenderer::Open(int sampleRate, int channels) {
  Close();
  sampleRate_ = sampleRate;
  channels_ = channels;
  AudioStreamBasicDescription asbd{};
  asbd.mSampleRate = sampleRate;
  asbd.mFormatID = kAudioFormatLinearPCM;
  asbd.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
  asbd.mBytesPerPacket = static_cast<UInt32>(channels * 4);
  asbd.mFramesPerPacket = 1;
  asbd.mBytesPerFrame = asbd.mBytesPerPacket;
  asbd.mChannelsPerFrame = static_cast<UInt32>(channels);
  asbd.mBitsPerChannel = 32;
  CMAudioFormatDescriptionRef fmt = nullptr;
  OSStatus os = CMAudioFormatDescriptionCreate(kCFAllocatorDefault, &asbd, 0,
                                               nullptr, 0, nullptr, nullptr, &fmt);
  if (os != noErr || fmt == nullptr) {
    return Status::Fail(kErrPreviewAudioOutputFailed, "audio format");
  }
  formatDesc_ = fmt;
  AVSampleBufferAudioRenderer* ar = [[AVSampleBufferAudioRenderer alloc] init];
  AVSampleBufferRenderSynchronizer* sync =
      [[AVSampleBufferRenderSynchronizer alloc] init];
  [sync addRenderer:ar];
  renderer_ = (__bridge_retained void*)ar;
  synchronizer_ = (__bridge_retained void*)sync;
  queued_ = 0;
  written_ = 0;
  VIDEO_LOGI("video.preview.audio ios open sr=%d ch=%d", sampleRate, channels);
  return Status::Ok();
}

void SampleBufferAudioRenderer::AttachVideoLayer(void* layer) {
  auto* sync = (__bridge AVSampleBufferRenderSynchronizer*)synchronizer_;
  auto* display = (__bridge AVSampleBufferDisplayLayer*)layer;
  if (sync == nil || display == nil) return;
  if (@available(iOS 17.0, macOS 14.0, *)) {
    [sync addRenderer:display.sampleBufferRenderer];
  }
}

void SampleBufferAudioRenderer::Start() {
  auto* sync = (__bridge AVSampleBufferRenderSynchronizer*)synchronizer_;
  if (sync) [sync setRate:1.0 time:sync.currentTime];
}

void SampleBufferAudioRenderer::Pause() {
  auto* sync = (__bridge AVSampleBufferRenderSynchronizer*)synchronizer_;
  if (sync) [sync setRate:0 time:sync.currentTime];
}

void SampleBufferAudioRenderer::Flush(uint64_t) {
  auto* ar = (__bridge AVSampleBufferAudioRenderer*)renderer_;
  [ar flush];
  queued_ = 0;
}

void SampleBufferAudioRenderer::SetVolume(float v) {
  auto* ar = (__bridge AVSampleBufferAudioRenderer*)renderer_;
  ar.volume = v;
}

int SampleBufferAudioRenderer::Write(const float* data, int frames, int64_t ptsUs) {
  auto* ar = (__bridge AVSampleBufferAudioRenderer*)renderer_;
  CMAudioFormatDescriptionRef fmt = (CMAudioFormatDescriptionRef)formatDesc_;
  if (ar == nil || fmt == nullptr || frames <= 0) return 0;
  const size_t bytes = static_cast<size_t>(frames * channels_) * sizeof(float);
  void* copy = malloc(bytes);
  if (!copy) return 0;
  memcpy(copy, data, bytes);
  CMBlockBufferRef block = nullptr;
  OSStatus os = CMBlockBufferCreateWithMemoryBlock(
      kCFAllocatorDefault, copy, bytes, kCFAllocatorMalloc, nullptr, 0, bytes, 0,
      &block);
  if (os != noErr || block == nullptr) {
    free(copy);
    return 0;
  }
  CMSampleBufferRef sample = nullptr;
  const size_t one = bytes;
  CMSampleTimingInfo timing;
  timing.duration = CMTimeMake(frames, sampleRate_);
  timing.presentationTimeStamp = CMTimeMake(ptsUs, 1000000);
  timing.decodeTimeStamp = kCMTimeInvalid;
  os = CMSampleBufferCreateReady(kCFAllocatorDefault, block, fmt, frames, 1,
                                 &timing, 1, &one, &sample);
  CFRelease(block);
  if (os != noErr || sample == nullptr) return 0;
  [ar enqueueSampleBuffer:sample];
  CFRelease(sample);
  written_ += frames;
  queued_ = frames;
  return frames;
}

void SampleBufferAudioRenderer::Close() {
  if (synchronizer_) {
    CFRelease(synchronizer_);
    synchronizer_ = nullptr;
  }
  if (renderer_) {
    CFRelease(renderer_);
    renderer_ = nullptr;
  }
  if (formatDesc_) {
    CFRelease((CMFormatDescriptionRef)formatDesc_);
    formatDesc_ = nullptr;
  }
}

SynchronizerClock::SynchronizerClock(void* synchronizer)
    : synchronizer_(synchronizer) {}

int64_t SynchronizerClock::NowMediaUs() {
  auto* sync = (__bridge AVSampleBufferRenderSynchronizer*)synchronizer_;
  if (sync == nil) return 0;
  CMTime t = sync.currentTime;
  if (!CMTIME_IS_VALID(t) || t.timescale == 0) return 0;
  return static_cast<int64_t>(CMTimeGetSeconds(t) * 1e6);
}

void SynchronizerClock::SetRate(double rate, int64_t atMediaUs) {
  auto* sync = (__bridge AVSampleBufferRenderSynchronizer*)synchronizer_;
  if (sync == nil) return;
  CMTime t = CMTimeMake(atMediaUs, 1000000);
  [sync setRate:rate time:t];
}

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
