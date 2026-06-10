#import "../../SherpaOnnx.h"

#include "../sherpa-onnx-enhancement-wrapper.h"
#include "../core/EnhancementBridgeState.h"
#include "../core/EnhancementBridgeUtils.h"

#include "sherpa-onnx-model-path-fill.h"
#include "sherpa-onnx-validate-enhancement.h"

#include <map>
#include <mutex>
#include <optional>
#include <string>

namespace {

std::optional<std::string> OptionalUtf8String(NSString *value) {
  if (value == nil || [value length] == 0) {
    return std::nullopt;
  }
  return std::string([value UTF8String]);
}

void FillEnhancementModelPathsFromDict(
    NSDictionary *dict,
    sherpaonnx::EnhancementModelPaths &paths
) {
  if (![dict isKindOfClass:[NSDictionary class]]) {
    return;
  }
  std::map<std::string, std::string> pathMap;
  for (NSString *key in dict) {
    id value = dict[key];
    if ([value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0) {
      pathMap[std::string([key UTF8String])] = std::string([(NSString *)value UTF8String]);
    }
  }
  sherpaonnx::FillEnhancementModelPathsFromStringMap(pathMap, paths);
}

struct EnhancementInitScalars {
  int32_t numThreads = 1;
  bool debug = false;
  std::optional<std::string> provider;
};

EnhancementInitScalars ParseEnhancementInitScalars(NSDictionary *options) {
  EnhancementInitScalars scalars;
  if ([options[@"numThreads"] respondsToSelector:@selector(intValue)]) {
    scalars.numThreads = MAX(1, [options[@"numThreads"] intValue]);
  }
  if ([options[@"debug"] respondsToSelector:@selector(boolValue)]) {
    scalars.debug = [options[@"debug"] boolValue];
  }
  scalars.provider = OptionalUtf8String(options[@"provider"]);
  return scalars;
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
                    options:(NSDictionary *)options
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"ENHANCEMENT_INIT_ERROR", @"instanceId is required", nil);
    return;
  }

  NSString *initMode = options[@"initMode"];
  if (initMode == nil || [initMode length] == 0) {
    initMode = @"auto";
  }
  const bool isCustomInit = [initMode isEqualToString:@"custom"];
  const std::string instanceIdStr = [instanceId UTF8String];
  const EnhancementInitScalars scalars = ParseEnhancementInitScalars(options);

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

    sherpaonnx::EnhancementInitializeResult result;
    if (isCustomInit) {
      NSString *modelType = options[@"modelType"];
      if (modelType == nil || [modelType length] == 0 || [modelType isEqualToString:@"auto"]) {
        reject(@"ENHANCEMENT_INIT_ERROR", @"modelType is required for initMode custom", nil);
        return;
      }
      id pathsRaw = options[@"modelPaths"];
      NSDictionary *pathsDict =
          [pathsRaw isKindOfClass:[NSDictionary class]] ? (NSDictionary *)pathsRaw : nil;
      if (pathsDict == nil || pathsDict.count == 0) {
        reject(@"ENHANCEMENT_INIT_ERROR", @"modelPaths is required for initMode custom", nil);
        return;
      }

      sherpaonnx::EnhancementModelPaths paths;
      FillEnhancementModelPathsFromDict(pathsDict, paths);
      result = inst->wrapper->initializeCustom(
          std::string([modelType UTF8String]),
          paths,
          scalars.numThreads,
          scalars.provider,
          scalars.debug);
    } else {
      NSString *modelDir = options[@"modelDir"];
      if (modelDir == nil || [modelDir length] == 0) {
        reject(@"ENHANCEMENT_INIT_ERROR", @"modelDir is required for initMode auto", nil);
        return;
      }
      NSString *modelType = options[@"modelType"];
      std::string modelTypeStr = sherpaonnx::enhancement::bridge::ModelTypeOrAuto(modelType);
      result = inst->wrapper->initialize(
          std::string([modelDir UTF8String]),
          modelTypeStr,
          scalars.numThreads,
          scalars.provider,
          scalars.debug);
    }

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
                            options:(NSDictionary *)options
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"ONLINE_ENHANCEMENT_INIT_ERROR", @"instanceId is required", nil);
    return;
  }

  NSString *initMode = options[@"initMode"];
  if (initMode == nil || [initMode length] == 0) {
    initMode = @"auto";
  }
  const bool isCustomInit = [initMode isEqualToString:@"custom"];
  const std::string instanceIdStr = [instanceId UTF8String];
  const EnhancementInitScalars scalars = ParseEnhancementInitScalars(options);

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

    sherpaonnx::EnhancementInitializeResult result;
    if (isCustomInit) {
      NSString *modelType = options[@"modelType"];
      if (modelType == nil || [modelType length] == 0 || [modelType isEqualToString:@"auto"]) {
        reject(@"ONLINE_ENHANCEMENT_INIT_ERROR", @"modelType is required for initMode custom", nil);
        return;
      }
      id pathsRaw = options[@"modelPaths"];
      NSDictionary *pathsDict =
          [pathsRaw isKindOfClass:[NSDictionary class]] ? (NSDictionary *)pathsRaw : nil;
      if (pathsDict == nil || pathsDict.count == 0) {
        reject(@"ONLINE_ENHANCEMENT_INIT_ERROR", @"modelPaths is required for initMode custom", nil);
        return;
      }

      sherpaonnx::EnhancementModelPaths paths;
      FillEnhancementModelPathsFromDict(pathsDict, paths);
      result = inst->wrapper->initializeCustom(
          std::string([modelType UTF8String]),
          paths,
          scalars.numThreads,
          scalars.provider,
          scalars.debug);
    } else {
      NSString *modelDir = options[@"modelDir"];
      if (modelDir == nil || [modelDir length] == 0) {
        reject(@"ONLINE_ENHANCEMENT_INIT_ERROR", @"modelDir is required for initMode auto", nil);
        return;
      }
      NSString *modelType = options[@"modelType"];
      std::string modelTypeStr = sherpaonnx::enhancement::bridge::ModelTypeOrAuto(modelType);
      result = inst->wrapper->initialize(
          std::string([modelDir UTF8String]),
          modelTypeStr,
          scalars.numThreads,
          scalars.provider,
          scalars.debug);
    }

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
