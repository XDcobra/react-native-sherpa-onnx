#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>

#include <gtest/gtest.h>

TEST(SampleBufferHost, AudioRendererAcceptsFloat32) {
  AVSampleBufferAudioRenderer *ar = [[AVSampleBufferAudioRenderer alloc] init];
  AVSampleBufferRenderSynchronizer *sync =
      [[AVSampleBufferRenderSynchronizer alloc] init];
  ASSERT_NE(ar, nil);
  ASSERT_NE(sync, nil);
  [sync addRenderer:ar];
  EXPECT_NE(ar.status, AVQueuedSampleBufferRenderingStatusFailed);

  AudioStreamBasicDescription asbd{};
  asbd.mSampleRate = 48000;
  asbd.mFormatID = kAudioFormatLinearPCM;
  asbd.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
  asbd.mBytesPerPacket = 8;
  asbd.mFramesPerPacket = 1;
  asbd.mBytesPerFrame = 8;
  asbd.mChannelsPerFrame = 2;
  asbd.mBitsPerChannel = 32;
  CMAudioFormatDescriptionRef fmt = nullptr;
  OSStatus os = CMAudioFormatDescriptionCreate(kCFAllocatorDefault, &asbd, 0,
                                               nullptr, 0, nullptr, nullptr, &fmt);
  ASSERT_EQ(os, noErr);
  ASSERT_NE(fmt, nullptr);

  const int frames = 1024;
  const size_t bytes = static_cast<size_t>(frames * 2) * sizeof(float);
  void *mem = calloc(1, bytes);
  ASSERT_NE(mem, nullptr);
  CMBlockBufferRef block = nullptr;
  os = CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault, mem, bytes,
                                          kCFAllocatorMalloc, nullptr, 0, bytes,
                                          0, &block);
  ASSERT_EQ(os, noErr);
  CMSampleBufferRef sample = nullptr;
  size_t one = bytes;
  CMSampleTimingInfo timing;
  timing.duration = CMTimeMake(frames, 48000);
  timing.presentationTimeStamp = CMTimeMake(0, 48000);
  timing.decodeTimeStamp = kCMTimeInvalid;
  os = CMSampleBufferCreateReady(kCFAllocatorDefault, block, fmt, frames, 1,
                                 &timing, 1, &one, &sample);
  ASSERT_EQ(os, noErr);
  [ar enqueueSampleBuffer:sample];
  [sync setRate:1.0 time:kCMTimeZero];
  CFTimeInterval t0 = CMTimeGetSeconds(sync.currentTime);
  [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  [sync setRate:0 time:sync.currentTime];
  CFTimeInterval t1 = CMTimeGetSeconds(sync.currentTime);
  EXPECT_GE(t1, t0);
  EXPECT_NE(ar.status, AVQueuedSampleBufferRenderingStatusFailed);
  [sync removeRenderer:ar atTime:sync.currentTime completionHandler:nil];
  CFTimeInterval t2 = CMTimeGetSeconds(sync.currentTime);
  EXPECT_TRUE(CMTIME_IS_VALID(sync.currentTime));
  (void)t2;
  if (sample) CFRelease(sample);
  if (block) CFRelease(block);
  if (fmt) CFRelease(fmt);
}

TEST(SampleBufferHost, DisplayLayerFlushDoesNotFail) {
  AVSampleBufferDisplayLayer *layer = [[AVSampleBufferDisplayLayer alloc] init];
  ASSERT_NE(layer, nil);
  [layer flush];
  EXPECT_NE(layer.status, AVQueuedSampleBufferRenderingStatusFailed);
}
