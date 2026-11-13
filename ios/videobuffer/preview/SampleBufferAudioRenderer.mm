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

// Open() runs again on every seek (AudioFeeder::Start). It only swaps the
// audio renderer and its format. The synchronizer lives for the renderer's
// whole lifetime: the player's SynchronizerClock and the attached video layer
// both reference it, and a fresh synchronizer per seek left the video layer on
// a dead timebase (picture frozen while the clock ran).
Status SampleBufferAudioRenderer::Open(int sampleRate, int channels) {
  if (synchronizer_ == nullptr) {
    AVSampleBufferRenderSynchronizer* created =
        [[AVSampleBufferRenderSynchronizer alloc] init];
    synchronizer_ = (__bridge_retained void*)created;
  }
  auto* sync = (__bridge AVSampleBufferRenderSynchronizer*)synchronizer_;
  if (renderer_) {
    auto* old = (__bridge AVSampleBufferAudioRenderer*)renderer_;
    [sync removeRenderer:old atTime:sync.currentTime completionHandler:nil];
    CFRelease(renderer_);
    renderer_ = nullptr;
  }
  if (formatDesc_) {
    CFRelease((CMFormatDescriptionRef)formatDesc_);
    formatDesc_ = nullptr;
  }
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
  [sync addRenderer:ar];
  renderer_ = (__bridge_retained void*)ar;
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
    AVSampleBufferVideoRenderer* next = display.sampleBufferRenderer;
    auto* prev = (__bridge AVSampleBufferVideoRenderer*)attachedVideoRenderer_;
    if (prev == next) return;
    if (prev != nil) {
      [sync removeRenderer:prev atTime:sync.currentTime completionHandler:nil];
      CFRelease(attachedVideoRenderer_);
      attachedVideoRenderer_ = nullptr;
    }
    [sync addRenderer:next];
    attachedVideoRenderer_ = (__bridge_retained void*)next;
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
  // Backpressure: the feeder retries a refused chunk. Accepting everything
  // queued the whole decoded track up front (memory grows with the duration).
  if (!ar.isReadyForMoreMediaData) return 0;
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
  if (attachedVideoRenderer_) {
    auto* sync = (__bridge AVSampleBufferRenderSynchronizer*)synchronizer_;
    auto* prev = (__bridge AVSampleBufferVideoRenderer*)attachedVideoRenderer_;
    if (sync != nil) {
      [sync removeRenderer:prev atTime:sync.currentTime completionHandler:nil];
    }
    CFRelease(attachedVideoRenderer_);
    attachedVideoRenderer_ = nullptr;
  }
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

// The clock keeps its own reference: the pump thread may still read it after
// SampleBufferAudioRenderer::Close() released the renderer's reference (e.g. a
// preview view detaching while playback runs) — a borrowed pointer crashed in
// objc_retain from NowMediaUs().
SynchronizerClock::SynchronizerClock(void* synchronizer)
    : synchronizer_(synchronizer) {
  if (synchronizer_) CFRetain(synchronizer_);
}

SynchronizerClock::~SynchronizerClock() {
  if (synchronizer_) {
    CFRelease(synchronizer_);
    synchronizer_ = nullptr;
  }
}

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
