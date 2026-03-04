/**
 * SherpaOnnx+PcmLiveStream.mm
 *
 * Native PCM live capture from the microphone via Audio Queue API (AudioQueueNewInput).
 * Delivers Int16 PCM at the requested sample rate; emits pcmLiveStreamData events (base64).
 * Works on both device and Simulator (same approach as react-native-live-audio-stream).
 */

#import "SherpaOnnx.h"
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <React/RCTLog.h>

static const UInt32 kPcmLiveAQNumberBuffers = 3;

static NSInteger _pcmLiveTargetSampleRate = 16000;
static __weak SherpaOnnx *_pcmLiveModule = nil;
static AudioQueueRef _pcmLiveAudioQueue = NULL;
static AudioQueueBufferRef _pcmLiveAQBuffers[kPcmLiveAQNumberBuffers];
static volatile BOOL _pcmLiveAQRunning = NO;

static void emitPcmChunk(SherpaOnnx *module, const int16_t *samples, NSUInteger count, NSInteger sampleRate) {
  if (!module || count == 0) return;
  NSData *data = [NSData dataWithBytes:samples length:count * sizeof(int16_t)];
  NSString *base64 = [data base64EncodedStringWithOptions:0];
  [module sendEventWithName:@"pcmLiveStreamData"
                      body:@{ @"base64Pcm": base64, @"sampleRate": @(sampleRate) }];
}

static void emitPcmError(SherpaOnnx *module, NSString *message) {
  if (module)
    [module sendEventWithName:@"pcmLiveStreamError" body:@{ @"message": message ?: @"" }];
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
  emitPcmChunk(module, samples, count, (NSInteger)_pcmLiveTargetSampleRate);
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
  (void)optionsArg;
  [self _startPcmLiveStreamWithTargetRate:16000 resolve:resolve reject:reject];
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
  [self _startPcmLiveStreamWithTargetRate:targetRate resolve:resolve reject:reject];
}
#endif

- (void)_startPcmLiveStreamWithTargetRate:(int)targetRate
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
  fmt.mSampleRate = (Float64)targetRate;
  fmt.mFormatID = kAudioFormatLinearPCM;
  fmt.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
  fmt.mChannelsPerFrame = 1;
  fmt.mBitsPerChannel = 16;
  fmt.mBytesPerPacket = 2;
  fmt.mBytesPerFrame = 2;
  fmt.mFramesPerPacket = 1;

  OSStatus status = AudioQueueNewInput(&fmt, pcmLiveAQInputCallback, NULL, NULL, NULL, 0, &_pcmLiveAudioQueue);
  if (status != noErr) {
    [session setActive:NO withOptions:0 error:nil];
    reject(@"PCM_LIVE_STREAM_ERROR", [NSString stringWithFormat:@"AudioQueueNewInput failed: %d", (int)status], nil);
    return;
  }

  const UInt32 bufferByteSize = 2048;
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
