/**
 * SherpaOnnx+PipelineAudioMic.mm
 *
 * Focused mic capture bridge for pipeline live audio buffers.
 */

#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>

#include "../pipeline/PaLiveEntry.h"
#include "../pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#import "../session/PaAudioSessionCoordinator.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#include <mutex>
#include <vector>

static NSString *const kPAMicErrBufferNotFound = @"AUDIO_BUFFER_NOT_FOUND";
static NSString *const kPAMicErrBufferInvalidated = @"BUFFER_INVALIDATED";
static NSString *const kPAMicErrInvalidState = @"AUDIO_INVALID_STATE";
static NSString *const kPAMicErrCaptureError = @"AUDIO_CAPTURE_ERROR";

static NSString *pa_input_kind_for_port(AVAudioSessionPort portType) {
  if ([portType isEqualToString:AVAudioSessionPortBuiltInMic]) return @"built_in_mic";
  if ([portType isEqualToString:AVAudioSessionPortHeadsetMic]) return @"wired_headset";
  if ([portType isEqualToString:AVAudioSessionPortBluetoothHFP] ||
      [portType isEqualToString:AVAudioSessionPortBluetoothLE]) return @"bluetooth";
  if ([portType isEqualToString:AVAudioSessionPortUSBAudio]) return @"usb";
  if ([portType isEqualToString:AVAudioSessionPortLineIn]) return @"line";
  return @"unknown";
}

static std::vector<int16_t> pa_mic_resample_int16(
  const int16_t *input,
  size_t inputSize,
  int fromRate,
  int toRate
) {
  if (fromRate == toRate) return std::vector<int16_t>(input, input + inputSize);
  double ratio = (double)fromRate / (double)toRate;
  size_t outLen = (size_t)round((double)inputSize / ratio);
  std::vector<int16_t> result(outLen);
  for (size_t i = 0; i < outLen; i++) {
    double srcIdx = i * ratio;
    size_t idx0 = std::min((size_t)srcIdx, inputSize - 1);
    size_t idx1 = std::min(idx0 + 1, inputSize - 1);
    float frac = (float)(srcIdx - idx0);
    int v = (int)((int)input[idx0] + ((int)input[idx1] - (int)input[idx0]) * frac);
    if (v < -32768) v = -32768;
    if (v > 32767) v = 32767;
    result[i] = (int16_t)v;
  }
  return result;
}

static const int kPaMicCaptureRates[] = {16000, 44100, 48000};
static const size_t kPaMicCaptureRatesCount = 3;
static const UInt32 kPaMicAQNumberBuffers = 3;

static std::shared_ptr<PaLiveEntry> g_pa_mic_live_entry = nullptr;
static AudioQueueRef g_pa_mic_audio_queue = NULL;
static AudioQueueBufferRef g_pa_mic_aq_buffers[kPaMicAQNumberBuffers];
static volatile BOOL g_pa_mic_aq_running = NO;
static NSInteger g_pa_mic_capture_rate = 16000;

// Exposed for module teardown (see SherpaOnnx.mm invalidate).
void paMicStopQueue(void) {
  if (g_pa_mic_audio_queue == NULL) return;
  g_pa_mic_aq_running = NO;
  AudioQueueStop(g_pa_mic_audio_queue, true);
  for (UInt32 i = 0; i < kPaMicAQNumberBuffers; i++) {
    if (g_pa_mic_aq_buffers[i] != NULL) {
      AudioQueueFreeBuffer(g_pa_mic_audio_queue, g_pa_mic_aq_buffers[i]);
      g_pa_mic_aq_buffers[i] = NULL;
    }
  }
  AudioQueueDispose(g_pa_mic_audio_queue, true);
  g_pa_mic_audio_queue = NULL;
  if (g_pa_mic_live_entry) {
    g_pa_mic_live_entry->flushPendingFramesAppended();
  }
  g_pa_mic_live_entry = nullptr;
}

static void paMicAQInputCallback(
  void *inUserData,
  AudioQueueRef inAQ,
  AudioQueueBufferRef inBuffer,
  const AudioTimeStamp *inStartTime,
  UInt32 inNumPackets,
  const AudioStreamPacketDescription *inPacketDesc
) {
  (void)inUserData;
  (void)inStartTime;
  (void)inNumPackets;
  (void)inPacketDesc;
  if (!g_pa_mic_aq_running) return;

  auto liveEntry = g_pa_mic_live_entry;
  if (!liveEntry || liveEntry->state != PaLiveEntry::RECORDING) return;

  UInt32 byteSize = inBuffer->mAudioDataByteSize;
  if (byteSize == 0) {
    AudioQueueEnqueueBuffer(inAQ, inBuffer, 0, NULL);
    return;
  }

  const int16_t *rawSamples = (const int16_t *)inBuffer->mAudioData;
  NSUInteger rawCount = byteSize / sizeof(int16_t);
  int targetRate = liveEntry->sampleRate;

  std::vector<int16_t> resampledBuf;
  const int16_t *samples16 = rawSamples;
  size_t count16 = rawCount;
  if ((int)g_pa_mic_capture_rate != targetRate) {
    resampledBuf = pa_mic_resample_int16(rawSamples, rawCount, (int)g_pa_mic_capture_rate, targetRate);
    samples16 = resampledBuf.data();
    count16 = resampledBuf.size();
  }

  std::vector<float> floatSamples(count16);
  for (size_t i = 0; i < count16; i++) {
    floatSamples[i] = (float)samples16[i] / 32768.0f;
  }
  auto appendResult = liveEntry->tryAppendSamples(
    floatSamples.data(),
    floatSamples.size(),
    targetRate,
    kPaAppendSourceMic
  );
  if (appendResult == PaLiveEntry::AppendResult::BUFFER_FINALIZED) {
    g_pa_mic_aq_running = false;
    return;
  }

  AudioQueueEnqueueBuffer(inAQ, inBuffer, 0, NULL);
}

@implementation SherpaOnnx (PipelineAudioMic)

#if __has_include(<SherpaOnnxSpec/SherpaOnnxSpec.h>)

- (void)startMicToLiveAudioBuffer:(NSString *)liveBufferId
                          options:(NSDictionary *)options
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  @try {
    paMicStopQueue();

    std::string liveId = [liveBufferId UTF8String];
    std::shared_ptr<PaLiveEntry> live;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_live.find(liveId);
      if (it == g_pa_live.end()) {
        if (g_pa_invalidated_live_ids.find(liveId) != g_pa_invalidated_live_ids.end()) {
          reject(kPAMicErrBufferInvalidated, @"Live buffer is invalidated after transfer", nil);
        } else {
          reject(kPAMicErrBufferNotFound, @"Live buffer not found", nil);
        }
        return;
      }
      live = it->second;
    }
    if (live->state != PaLiveEntry::RECORDING) {
      reject(kPAMicErrInvalidState, @"Live buffer is finalized", nil);
      return;
    }

    g_pa_mic_live_entry = live;

    // Compatibility option: emitToJs now toggles centralized append-event emission.
    if (options[@"emitToJs"] != nil) {
      bool emitToJs = [options[@"emitToJs"] boolValue];
      live->configureAppendEvents(emitToJs, live->appendEventMinIntervalMs);
    }

    // Register mic intent with coordinator (handles AVAudioSession category/activation)
    PaAudioSessionIntent *micIntent = [PaAudioSessionIntent intentWithOwnerId:@"mic"
                                                                   needsInput:YES
                                                                  needsOutput:NO];
    [[PaAudioSessionCoordinator shared] acquireIntent:micIntent];

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
    int chosenRate = 16000;
    for (size_t r = 0; r < kPaMicCaptureRatesCount; r++) {
      chosenRate = kPaMicCaptureRates[r];
      fmt.mSampleRate = (Float64)chosenRate;
      status = AudioQueueNewInput(&fmt, paMicAQInputCallback, NULL, NULL, NULL, 0, &g_pa_mic_audio_queue);
      if (status == noErr) break;
      g_pa_mic_audio_queue = NULL;
    }
    if (status != noErr || g_pa_mic_audio_queue == NULL) {
      [[PaAudioSessionCoordinator shared] releaseIntent:@"mic"];
      reject(kPAMicErrCaptureError, @"AudioQueueNewInput failed", nil);
      return;
    }
    g_pa_mic_capture_rate = chosenRate;

    UInt32 bufferByteSize = 2048;
    for (UInt32 i = 0; i < kPaMicAQNumberBuffers; i++) {
      status = AudioQueueAllocateBuffer(g_pa_mic_audio_queue, bufferByteSize, &g_pa_mic_aq_buffers[i]);
      if (status != noErr) {
        paMicStopQueue();
        [[PaAudioSessionCoordinator shared] releaseIntent:@"mic"];
        reject(kPAMicErrCaptureError, @"AudioQueueAllocateBuffer failed", nil);
        return;
      }
      AudioQueueEnqueueBuffer(g_pa_mic_audio_queue, g_pa_mic_aq_buffers[i], 0, NULL);
    }

    g_pa_mic_aq_running = YES;
    status = AudioQueueStart(g_pa_mic_audio_queue, NULL);
    if (status != noErr) {
      paMicStopQueue();
      [[PaAudioSessionCoordinator shared] releaseIntent:@"mic"];
      reject(kPAMicErrCaptureError, @"AudioQueueStart failed", nil);
      return;
    }

    resolve(nil);
  } @catch (NSException *e) {
    reject(kPAMicErrCaptureError, e.reason, nil);
  }
}

- (void)stopMicToLiveAudioBuffer:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  paMicStopQueue();
  [[PaAudioSessionCoordinator shared] releaseIntent:@"mic"];
  resolve(nil);
}

- (void)listAvailableInputDevices:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  @try {
    AVAudioSession *session = [AVAudioSession sharedInstance];
    AVAudioSessionRouteDescription *route = session.currentRoute;
    NSString *selectedInputId = route.inputs.firstObject.UID;

    NSArray<AVAudioSessionPortDescription *> *availableInputs = session.availableInputs ?: @[];
    NSMutableArray<NSMutableDictionary *> *out = [NSMutableArray arrayWithCapacity:availableInputs.count];

    for (AVAudioSessionPortDescription *input in availableInputs) {
      BOOL isDefault = [input.portType isEqualToString:AVAudioSessionPortBuiltInMic];
      BOOL isSelected = selectedInputId != nil && [input.UID isEqualToString:selectedInputId];
      NSMutableDictionary *entry = [@{
        @"id": input.UID ?: @"",
        @"name": input.portName ?: @"Input",
        @"kind": pa_input_kind_for_port(input.portType),
        @"selected": @(isSelected),
        @"default": @(isDefault),
        @"canSelect": @YES,
      } mutableCopy];
      [out addObject:entry];
    }

    if (out.count > 0) {
      BOOL hasSelected = NO;
      for (NSDictionary *entry in out) {
        if ([entry[@"selected"] boolValue]) {
          hasSelected = YES;
          break;
        }
      }
      if (!hasSelected) {
        NSUInteger fallbackIndex = NSNotFound;
        for (NSUInteger i = 0; i < out.count; i++) {
          if ([out[i][@"default"] boolValue]) {
            fallbackIndex = i;
            break;
          }
        }
        if (fallbackIndex == NSNotFound) fallbackIndex = 0;
        out[fallbackIndex][@"selected"] = @YES;
      }
    }

    resolve(out);
  } @catch (NSException *e) {
    reject(kPAMicErrCaptureError, e.reason, nil);
  }
}

#endif

@end
