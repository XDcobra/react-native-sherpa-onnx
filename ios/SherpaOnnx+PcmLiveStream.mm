/**
 * SherpaOnnx+PcmLiveStream.mm
 *
 * Native PCM live capture from the microphone via Audio Queue API (AudioQueueNewInput).
 * Captures at a supported hardware rate (16000, 44100, 48000), resamples to the requested
 * target rate, and emits pcmLiveStreamData at target rate (same behavior as Android).
 */

#import "SherpaOnnx.h"
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <React/RCTLog.h>
#import <stdlib.h>

static const UInt32 kPcmLiveAQNumberBuffers = 3;
/** Capture sample rates to try in order (match Android CAPTURE_RATES). */
static const int kPcmLiveCaptureRates[] = { 16000, 44100, 48000 };
static const size_t kPcmLiveCaptureRatesCount = sizeof(kPcmLiveCaptureRates) / sizeof(kPcmLiveCaptureRates[0]);

static NSInteger _pcmLiveTargetSampleRate = 16000;
static NSInteger _pcmLiveCaptureRate = 16000;
static __weak SherpaOnnx *_pcmLiveModule = nil;
static AudioQueueRef _pcmLiveAudioQueue = NULL;
static AudioQueueBufferRef _pcmLiveAQBuffers[kPcmLiveAQNumberBuffers];
static volatile BOOL _pcmLiveAQRunning = NO;

static void emitPcmChunk(SherpaOnnx *module, const int16_t *samples, NSUInteger count, NSInteger sampleRate) {
  if (!module || count == 0) return;
  // Copy samples into NSData on the AudioQueue callback thread so the data
  // remains valid after the audio buffer is reused.
  NSData *data = [NSData dataWithBytes:samples length:count * sizeof(int16_t)];
  // Dispatch the React Native event emission to the main queue to avoid
  // bridge thread-safety issues.
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *base64 = [data base64EncodedStringWithOptions:0];
    [module sendEventWithName:@"pcmLiveStreamData"
                        body:@{ @"base64Pcm": base64, @"sampleRate": @(sampleRate) }];
  });
}

static void emitPcmError(SherpaOnnx *module, NSString *message) {
  if (!module) return;
  // Dispatch error events to the main queue to match other RN event patterns
  // and avoid bridge thread-safety issues.
  dispatch_async(dispatch_get_main_queue(), ^{
    [module sendEventWithName:@"pcmLiveStreamError" body:@{ @"message": message ?: @"" }];
  });
}

/** Resample Int16 PCM from fromRate to toRate using linear interpolation (match Android resampleInt16). */
static NSUInteger pcmLiveResampleInt16(const int16_t *input, NSUInteger inputFrames,
                                      int fromRate, int toRate,
                                      int16_t *output, size_t outputCapacity) {
  if (fromRate == toRate) {
    size_t copy = (inputFrames < outputCapacity) ? inputFrames : outputCapacity;
    memcpy(output, input, copy * sizeof(int16_t));
    return copy;
  }
  double ratio = (double)fromRate / (double)toRate;
  NSUInteger outLength = (NSUInteger)((double)inputFrames / ratio);
  if (outLength > outputCapacity) outLength = outputCapacity;
  if (outLength == 0) return 0;
  for (NSUInteger i = 0; i < outLength; i++) {
    double srcIdx = (double)i * ratio;
    NSUInteger idx0 = (NSUInteger)srcIdx;
    if (idx0 >= inputFrames) idx0 = inputFrames - 1;
    NSUInteger idx1 = idx0 + 1;
    if (idx1 >= inputFrames) idx1 = inputFrames - 1;
    float frac = (float)(srcIdx - (double)idx0);
    int v0 = (int)input[idx0];
    int v1 = (int)input[idx1];
    int v = (int)(v0 + (v1 - v0) * frac);
    if (v < -32768) v = -32768;
    if (v > 32767) v = 32767;
    output[i] = (int16_t)v;
  }
  return outLength;
}

static void pcmLiveAQInputCallback(void *inUserData,
                                   AudioQueueRef inAQ,
                                   AudioQueueBufferRef inBuffer,
                                   const AudioTimeStamp *inStartTime,
                                   UInt32 inNumPackets,
                                   const AudioStreamPacketDescription *inPacketDesc) {
  (void)inUserData;
  (void)inStartTime;
  (void)inNumPackets;
  (void)inPacketDesc;
  if (!_pcmLiveAQRunning) return;
  SherpaOnnx *module = _pcmLiveModule;
  if (!module) return;
  UInt32 byteSize = inBuffer->mAudioDataByteSize;
  if (byteSize == 0) {
    AudioQueueEnqueueBuffer(inAQ, inBuffer, 0, NULL);
    return;
  }
  const int16_t *samples = (const int16_t *)inBuffer->mAudioData;
  NSUInteger count = byteSize / sizeof(int16_t);
  NSInteger targetRate = _pcmLiveTargetSampleRate;
  NSInteger captureRate = _pcmLiveCaptureRate;

  if (captureRate == targetRate) {
    emitPcmChunk(module, samples, count, targetRate);
  } else {
    // Compute an upper bound on the number of output frames for resampling.
    NSUInteger maxOutFrames =
        (count * (NSUInteger)targetRate + (NSUInteger)captureRate - 1) /
        (NSUInteger)captureRate;
    if (maxOutFrames == 0) {
      AudioQueueEnqueueBuffer(inAQ, inBuffer, 0, NULL);
      return;
    }
    int16_t *resampleBuf = (int16_t *)malloc(maxOutFrames * sizeof(int16_t));
    if (resampleBuf == NULL) {
      emitPcmError(module, @"Failed to allocate resample buffer");
      AudioQueueEnqueueBuffer(inAQ, inBuffer, 0, NULL);
      return;
    }
    NSUInteger outFrames = pcmLiveResampleInt16(samples, count,
                                               (int)captureRate, (int)targetRate,
                                               resampleBuf, maxOutFrames);
    if (outFrames > 0)
      emitPcmChunk(module, resampleBuf, outFrames, targetRate);
    free(resampleBuf);
  }
  AudioQueueEnqueueBuffer(inAQ, inBuffer, 0, NULL);
}

static void pcmLiveStopQueue(void) {
  if (_pcmLiveAudioQueue == NULL) return;
  _pcmLiveAQRunning = NO;
  AudioQueueStop(_pcmLiveAudioQueue, true);
  for (UInt32 i = 0; i < kPcmLiveAQNumberBuffers; i++) {
    if (_pcmLiveAQBuffers[i] != NULL) {
      AudioQueueFreeBuffer(_pcmLiveAudioQueue, _pcmLiveAQBuffers[i]);
      _pcmLiveAQBuffers[i] = NULL;
    }
  }
  AudioQueueDispose(_pcmLiveAudioQueue, true);
  _pcmLiveAudioQueue = NULL;
}

@implementation SherpaOnnx (PcmLiveStream)

- (void)startPcmLiveStream:(id __unsafe_unretained)optionsArg
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  int targetRate = 16000;
  UInt32 bufferSizeFrames = 0;

  // Parse optionsArg coming from JS (fallback / non-codegen path).
  if ([optionsArg isKindOfClass:[NSDictionary class]]) {
    NSDictionary *dict = (NSDictionary *)optionsArg;

    id sampleRateValue = dict[@"sampleRate"];
    if ([sampleRateValue respondsToSelector:@selector(intValue)]) {
      int v = (int)[sampleRateValue intValue];
      if (v > 0) targetRate = v;
    }

    id bufferSizeValue = dict[@"bufferSizeFrames"];
    if ([bufferSizeValue respondsToSelector:@selector(doubleValue)]) {
      double v = [bufferSizeValue doubleValue];
      if (v > 0) bufferSizeFrames = (UInt32)v;
    }
  }

  [self _startPcmLiveStreamWithTargetRate:targetRate bufferSizeFrames:bufferSizeFrames resolve:resolve reject:reject];
}

#if __has_include(<SherpaOnnxSpec/SherpaOnnxSpec.h>)
- (void)startPcmLiveStreamWithOptions:(JS::NativeSherpaOnnx::SpecStartPcmLiveStreamOptions &)options
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
  int targetRate = 16000;
  if (options.sampleRate()) {
    targetRate = (int)options.sampleRate();
    if (targetRate <= 0) targetRate = 16000;
  }
  UInt32 bufferSizeFrames = 0;
  if (options.bufferSizeFrames().has_value()) {
    double v = options.bufferSizeFrames().value();
    if (v > 0) bufferSizeFrames = (UInt32)v;
  }
  [self _startPcmLiveStreamWithTargetRate:targetRate bufferSizeFrames:bufferSizeFrames resolve:resolve reject:reject];
}
#endif

- (void)_startPcmLiveStreamWithTargetRate:(int)targetRate
                       bufferSizeFrames:(UInt32)bufferSizeFrames
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
  pcmLiveStopQueue();

  _pcmLiveTargetSampleRate = targetRate;
  _pcmLiveModule = self;

  NSError *error = nil;
  AVAudioSession *session = [AVAudioSession sharedInstance];
  if (![session setCategory:AVAudioSessionCategoryPlayAndRecord
                       mode:AVAudioSessionModeDefault
                    options:AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionAllowBluetooth
                      error:&error]) {
    RCTLog(@"%@", [NSString stringWithFormat:@"[SherpaOnnx PcmLive] setCategory error: %@", error]);
    reject(@"PCM_LIVE_STREAM_ERROR", error.localizedDescription ?: @"Failed to set audio session", error);
    return;
  }
  if (![session setActive:YES withOptions:0 error:&error]) {
    RCTLog(@"%@", [NSString stringWithFormat:@"[SherpaOnnx PcmLive] setActive error: %@", error]);
    reject(@"PCM_LIVE_STREAM_ERROR", error.localizedDescription ?: @"Failed to activate audio session", error);
    return;
  }

  AudioStreamBasicDescription fmt;
  memset(&fmt, 0, sizeof(fmt));
  fmt.mFormatID = kAudioFormatLinearPCM;
  fmt.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
  fmt.mChannelsPerFrame = 1;
  fmt.mBitsPerChannel = 16;
  fmt.mBytesPerPacket = 2;
  fmt.mBytesPerFrame = 2;
  fmt.mFramesPerPacket = 1;

  OSStatus status = noErr;
  int chosenCaptureRate = 16000;
  for (size_t r = 0; r < kPcmLiveCaptureRatesCount; r++) {
    chosenCaptureRate = kPcmLiveCaptureRates[r];
    fmt.mSampleRate = (Float64)chosenCaptureRate;
    status = AudioQueueNewInput(&fmt, pcmLiveAQInputCallback, NULL, NULL, NULL, 0, &_pcmLiveAudioQueue);
    if (status == noErr) break;
    _pcmLiveAudioQueue = NULL;
  }
  if (status != noErr || _pcmLiveAudioQueue == NULL) {
    [session setActive:NO withOptions:0 error:nil];
    reject(@"PCM_LIVE_STREAM_ERROR", [NSString stringWithFormat:@"AudioQueueNewInput failed for all rates (last: %d)", (int)status], nil);
    return;
  }
  _pcmLiveCaptureRate = chosenCaptureRate;

  UInt32 bufferByteSize = 2048;
  if (bufferSizeFrames > 0) {
    bufferByteSize = bufferSizeFrames * 2;  /* 16-bit mono */
    if (bufferByteSize < 1024) bufferByteSize = 1024;
    if (bufferByteSize > 32768) bufferByteSize = 32768;
  }

  for (UInt32 i = 0; i < kPcmLiveAQNumberBuffers; i++) {
    status = AudioQueueAllocateBuffer(_pcmLiveAudioQueue, bufferByteSize, &_pcmLiveAQBuffers[i]);
    if (status != noErr) {
      pcmLiveStopQueue();
      [session setActive:NO withOptions:0 error:nil];
      reject(@"PCM_LIVE_STREAM_ERROR", [NSString stringWithFormat:@"AudioQueueAllocateBuffer failed: %d", (int)status], nil);
      return;
    }
    AudioQueueEnqueueBuffer(_pcmLiveAudioQueue, _pcmLiveAQBuffers[i], 0, NULL);
  }

  _pcmLiveAQRunning = YES;
  status = AudioQueueStart(_pcmLiveAudioQueue, NULL);
  if (status != noErr) {
    pcmLiveStopQueue();
    [session setActive:NO withOptions:0 error:nil];
    reject(@"PCM_LIVE_STREAM_ERROR", [NSString stringWithFormat:@"AudioQueueStart failed: %d", (int)status], nil);
    return;
  }

  resolve(nil);
}

- (void)stopPcmLiveStream:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [self stopPcmLiveStreamWithResolve:resolve reject:reject];
}

- (void)stopPcmLiveStreamWithResolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  pcmLiveStopQueue();
  [[AVAudioSession sharedInstance] setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
  resolve(nil);
}

@end
