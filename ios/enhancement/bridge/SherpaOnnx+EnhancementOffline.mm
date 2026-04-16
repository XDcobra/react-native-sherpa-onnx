#import "../../SherpaOnnx.h"

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../sherpa-onnx-enhancement-wrapper.h"
#include "../core/EnhancementBridgeState.h"

#include <memory>
#include <mutex>
#include <string>
#include <vector>

@implementation SherpaOnnx (Enhancement)

- (void)enhanceOfflineAudioBuffers:(NSString *)instanceId
                   audioInBufferId:(NSString *)audioInBufferId
                  audioOutBufferId:(NSString *)audioOutBufferId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"ENHANCEMENT_ERROR", @"instanceId is required", nil);
    return;
  }
  if (audioInBufferId == nil || [audioInBufferId length] == 0) {
    reject(@"ENHANCEMENT_BUFFER_NOT_FOUND", @"audioInBufferId is required", nil);
    return;
  }
  if (audioOutBufferId == nil || [audioOutBufferId length] == 0) {
    reject(@"ENHANCEMENT_BUFFER_NOT_FOUND", @"audioOutBufferId is required", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  std::string audioInId = [audioInBufferId UTF8String];
  std::string audioOutId = [audioOutBufferId UTF8String];

  if (audioInId.find("off_") != 0) {
    reject(@"ENHANCEMENT_BUFFER_KIND_MISMATCH",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*) for audioIn, got: %@", audioInBufferId],
           nil);
    return;
  }

  if (audioOutId.find("off_") != 0) {
    reject(@"ENHANCEMENT_BUFFER_KIND_MISMATCH",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*) for audioOut, got: %@", audioOutBufferId],
           nil);
    return;
  }

  int inSampleRate = 0;
  int inNumSamples = 0;
  std::string errCode;
  std::string errMsg;
  if (!pa_get_offline_metadata(audioInId, &inSampleRate, &inNumSamples, &errCode, &errMsg)) {
    reject(@"ENHANCEMENT_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioInBufferId],
           nil);
    return;
  }

  int outSampleRate = 0;
  int outNumSamples = 0;
  if (!pa_get_offline_metadata(audioOutId, &outSampleRate, &outNumSamples, &errCode, &errMsg)) {
    reject(@"ENHANCEMENT_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioOutBufferId],
           nil);
    return;
  }

  if (inSampleRate <= 0 || inNumSamples <= 0) {
    reject(@"ENHANCEMENT_BUFFER_EMPTY",
           [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioInBufferId],
           nil);
    return;
  }

  if (outNumSamples != 0) {
    reject(@"ENHANCEMENT_OUTPUT_NOT_EMPTY",
           [NSString stringWithFormat:@"Output offline audio buffer must be empty: %@", audioOutBufferId],
           nil);
    return;
  }

  @try {
    std::vector<float> inputSamples;
    int inputSr = 0;
    if (!pa_read_offline_samples(audioInId, &inputSamples, &inputSr) || inputSamples.empty()) {
      reject(@"ENHANCEMENT_BUFFER_EMPTY",
             [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioInBufferId],
             nil);
      return;
    }

    sherpaonnx::EnhancedAudioResult enhancedResult;
    {
      std::lock_guard<std::mutex> lock(sherpaonnx::enhancement::bridge::g_enhancement_mutex);
      auto it = sherpaonnx::enhancement::bridge::g_enhancement_instances.find(instanceIdStr);
      if (it == sherpaonnx::enhancement::bridge::g_enhancement_instances.end() || it->second->wrapper == nullptr) {
        reject(@"ENHANCEMENT_ERROR", @"Enhancement instance not found", nil);
        return;
      }
      enhancedResult = it->second->wrapper->runSamples(inputSamples, inputSr);
    }

    {
      std::string adoptErrCode;
      std::string adoptErrMsg;
      if (!pa_adopt_offline_samples_if_empty(audioOutId, std::move(enhancedResult.samples), &adoptErrCode, &adoptErrMsg)) {
        reject(@"ENHANCEMENT_OUTPUT_NOT_EMPTY",
               [NSString stringWithFormat:@"Output buffer was populated concurrently: %@", audioOutBufferId],
               nil);
        return;
      }
    }

    // Upgrade output to mmap if it exceeds the threshold
    pa_upgradeToMmapIfNeeded(audioOutId);

    resolve(nil);
  } @catch (NSException *exception) {
    reject(@"ENHANCEMENT_ERROR",
           [NSString stringWithFormat:@"Enhancement failed: %@", exception.reason],
           nil);
  }
}

- (void)getEnhancementSampleRate:(NSString *)instanceId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"ENHANCEMENT_ERROR", @"instanceId is required", nil);
    return;
  }
  std::string instanceIdStr = [instanceId UTF8String];

  std::lock_guard<std::mutex> lock(sherpaonnx::enhancement::bridge::g_enhancement_mutex);
  auto it = sherpaonnx::enhancement::bridge::g_enhancement_instances.find(instanceIdStr);
  if (it == sherpaonnx::enhancement::bridge::g_enhancement_instances.end() || it->second->wrapper == nullptr) {
    reject(@"ENHANCEMENT_ERROR", @"Enhancement instance not found", nil);
    return;
  }
  resolve(@(it->second->wrapper->getSampleRate()));
}

- (void)unloadEnhancement:(NSString *)instanceId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }
  std::string instanceIdStr = [instanceId UTF8String];
  std::lock_guard<std::mutex> lock(sherpaonnx::enhancement::bridge::g_enhancement_mutex);
  auto it = sherpaonnx::enhancement::bridge::g_enhancement_instances.find(instanceIdStr);
  if (it != sherpaonnx::enhancement::bridge::g_enhancement_instances.end() && it->second->wrapper != nullptr) {
    it->second->wrapper->release();
    sherpaonnx::enhancement::bridge::g_enhancement_instances.erase(it);
  }
  resolve(nil);
}

@end