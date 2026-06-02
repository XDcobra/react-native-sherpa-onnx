#import "../../SherpaOnnx.h"

#include "../sherpa-onnx-enhancement-wrapper.h"
#include "../core/EnhancementBridgeState.h"
#include "../core/EnhancementBridgeUtils.h"

#include <optional>
#include <string>

namespace {

std::optional<std::string> OptionalUtf8String(NSString *value) {
  if (value == nil || [value length] == 0) {
    return std::nullopt;
  }
  return std::string([value UTF8String]);
}

}  // namespace

@implementation SherpaOnnx (Enhancement)

- (void)detectEnhancementModel:(NSString *)modelDir
                     assetName:(NSString * _Nullable)assetName
                     modelType:(NSString * _Nullable)modelType
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  @try {
    auto modelDirOpt = OptionalUtf8String(modelDir);
    auto assetNameOpt = OptionalUtf8String(assetName);
    std::string modelTypeStr = sherpaonnx::enhancement::bridge::ModelTypeOrAuto(modelType);

    auto result = sherpaonnx::DetectEnhancementModel(modelDirOpt, assetNameOpt, modelTypeStr);
    resolve(sherpaonnx::enhancement::bridge::EnhancementDetectResultToDict(result));
  } @catch (NSException *exception) {
    reject(@"DETECT_ERROR",
           [NSString stringWithFormat:@"Enhancement detect failed: %@", exception.reason],
           nil);
  }
}

- (void)initializeEnhancement:(NSString *)instanceId
                     modelDir:(NSString *)modelDir
                    modelType:(NSString *)modelType
                   numThreads:(NSNumber *)numThreads
                     provider:(NSString *)provider
                        debug:(NSNumber *)debug
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"ENHANCEMENT_INIT_ERROR", @"instanceId is required", nil);
    return;
  }
  if (modelDir == nil || [modelDir length] == 0) {
    reject(@"ENHANCEMENT_INIT_ERROR", @"modelDir is required", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  std::string modelDirStr = [modelDir UTF8String];
  std::string modelTypeStr = sherpaonnx::enhancement::bridge::ModelTypeOrAuto(modelType);
  int32_t numThreadsVal = numThreads != nil ? [numThreads intValue] : 1;
  bool debugVal = debug != nil && [debug boolValue];
  std::optional<std::string> providerOpt = OptionalUtf8String(provider);

  @try {
    std::lock_guard<std::mutex> lock(sherpaonnx::enhancement::bridge::g_enhancement_mutex);
    auto it = sherpaonnx::enhancement::bridge::g_enhancement_instances.find(instanceIdStr);
    if (it == sherpaonnx::enhancement::bridge::g_enhancement_instances.end()) {
      sherpaonnx::enhancement::bridge::g_enhancement_instances[instanceIdStr] =
          std::make_unique<sherpaonnx::enhancement::bridge::EnhancementInstanceState>();
    }

    auto *inst = sherpaonnx::enhancement::bridge::g_enhancement_instances[instanceIdStr].get();
    if (inst->wrapper == nullptr) {
      inst->wrapper = std::make_unique<sherpaonnx::EnhancementWrapper>();
    }

    auto result = inst->wrapper->initialize(
        modelDirStr,
        modelTypeStr,
        numThreadsVal,
        providerOpt,
        debugVal);

    if (!result.success) {
      NSString *errorMsg = result.error.empty()
          ? @"Failed to initialize enhancement"
          : [NSString stringWithUTF8String:result.error.c_str()];
      reject(@"ENHANCEMENT_INIT_ERROR", errorMsg, nil);
      return;
    }

    NSMutableArray *detectedModelsArray = [NSMutableArray array];
    for (const auto &model : result.detectedModels) {
      [detectedModelsArray addObject:@{
        @"type": [NSString stringWithUTF8String:model.type.c_str()] ?: @"",
        @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()] ?: @""
      }];
    }

    resolve(@{
      @"success": @YES,
      @"detectedModels": detectedModelsArray,
      @"modelType": [NSString stringWithUTF8String:result.modelType.c_str()] ?: @"unknown",
      @"sampleRate": @(result.sampleRate)
    });
  } @catch (NSException *exception) {
    reject(@"ENHANCEMENT_INIT_ERROR",
           [NSString stringWithFormat:@"Enhancement init failed: %@", exception.reason],
           nil);
  }
}

- (void)initializeOnlineEnhancement:(NSString *)instanceId
                           modelDir:(NSString *)modelDir
                          modelType:(NSString *)modelType
                         numThreads:(NSNumber *)numThreads
                           provider:(NSString *)provider
                              debug:(NSNumber *)debug
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"ONLINE_ENHANCEMENT_INIT_ERROR", @"instanceId is required", nil);
    return;
  }
  if (modelDir == nil || [modelDir length] == 0) {
    reject(@"ONLINE_ENHANCEMENT_INIT_ERROR", @"modelDir is required", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  std::string modelDirStr = [modelDir UTF8String];
  std::string modelTypeStr = sherpaonnx::enhancement::bridge::ModelTypeOrAuto(modelType);
  int32_t numThreadsVal = numThreads != nil ? [numThreads intValue] : 1;
  bool debugVal = debug != nil && [debug boolValue];
  std::optional<std::string> providerOpt = OptionalUtf8String(provider);

  @try {
    std::lock_guard<std::mutex> lock(sherpaonnx::enhancement::bridge::g_enhancement_mutex);
    auto it = sherpaonnx::enhancement::bridge::g_online_enhancement_instances.find(instanceIdStr);
    if (it == sherpaonnx::enhancement::bridge::g_online_enhancement_instances.end()) {
      sherpaonnx::enhancement::bridge::g_online_enhancement_instances[instanceIdStr] =
          std::make_unique<sherpaonnx::enhancement::bridge::OnlineEnhancementInstanceState>();
    }

    auto *inst = sherpaonnx::enhancement::bridge::g_online_enhancement_instances[instanceIdStr].get();
    if (inst->wrapper == nullptr) {
      inst->wrapper = std::make_shared<sherpaonnx::OnlineEnhancementWrapper>();
    }

    auto result = inst->wrapper->initialize(
        modelDirStr,
        modelTypeStr,
        numThreadsVal,
        providerOpt,
        debugVal);

    if (!result.success) {
      NSString *errorMsg = result.error.empty()
          ? @"Failed to initialize online enhancement"
          : [NSString stringWithUTF8String:result.error.c_str()];
      reject(@"ONLINE_ENHANCEMENT_INIT_ERROR", errorMsg, nil);
      return;
    }

    resolve(@{
      @"success": @YES,
      @"sampleRate": @(result.sampleRate),
      @"frameShiftInSamples": @(result.frameShiftInSamples)
    });
  } @catch (NSException *exception) {
    reject(@"ONLINE_ENHANCEMENT_INIT_ERROR",
           [NSString stringWithFormat:@"Online enhancement init failed: %@", exception.reason],
           nil);
  }
}

@end