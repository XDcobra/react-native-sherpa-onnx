#import <Foundation/Foundation.h>

#include "EnhancementBridgeUtils.h"
#include "sherpa-onnx-model-path-fill.h"
#import "../../detect/native/sherpa-onnx-public-language-row-bridge.h"

namespace sherpaonnx {
namespace enhancement {
namespace bridge {

NSString *EnhancementKindToNSString(sherpaonnx::EnhancementModelKind kind) {
  using K = sherpaonnx::EnhancementModelKind;
  switch (kind) {
    case K::kGtcrn:
      return @"gtcrn";
    case K::kDpdfNet:
      return @"dpdfnet";
    case K::kVoxLock:
      return @"voxlock";
    default:
      return @"unknown";
  }
}

NSDictionary *EnhancementDetectResultToDict(const sherpaonnx::EnhancementDetectResult &result) {
  NSMutableArray *detectedModelsArray = [NSMutableArray array];
  for (const auto &model : result.detectedModels) {
    [detectedModelsArray addObject:@{
      @"type": [NSString stringWithUTF8String:model.type.c_str()] ?: @"",
      @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()] ?: @""
    }];
  }

  NSMutableDictionary *dict = [@{
    @"success": @(result.ok),
    @"isStreaming": @(result.isStreaming),
    @"detectedModels": detectedModelsArray,
    @"modelType": EnhancementKindToNSString(result.selectedKind),
  } mutableCopy];

  if (!result.detectionSources.empty()) {
    NSMutableArray *sources = [NSMutableArray array];
    for (const auto source : result.detectionSources) {
      [sources addObject:[NSString stringWithUTF8String:sherpaonnx::DetectionSourceToLiteral(source)] ?: @""];
    }
    dict[@"detectionSources"] = sources;
  }

  if (!result.derivedLanguages.empty()) {
    dict[@"languages"] =
        sherpaonnx::detect::bridge::PublicLanguageRowsToNSArray(result.derivedLanguages);
  }

  if (!result.quantization.empty()) {
    dict[@"quantization"] = [NSString stringWithUTF8String:result.quantization.c_str()] ?: @"";
  }

  if (!result.ok && !result.error.empty()) {
    dict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()] ?: @"Enhancement model detection failed";
  }

  const auto pathMap = sherpaonnx::EnhancementModelPathsToStringMap(result.paths);
  if (!pathMap.empty()) {
    NSMutableDictionary *paths = [NSMutableDictionary dictionary];
    for (const auto &entry : pathMap) {
      NSString *key = [NSString stringWithUTF8String:entry.first.c_str()];
      NSString *value = [NSString stringWithUTF8String:entry.second.c_str()];
      if (key != nil && value != nil && value.length > 0) {
        paths[key] = value;
      }
    }
    if (paths.count > 0) {
      dict[@"paths"] = paths;
    }
  }

  return dict;
}

std::string ModelTypeOrAuto(NSString *modelType) {
  if (modelType == nil || [modelType length] == 0) {
    return "auto";
  }
  return std::string([modelType UTF8String]);
}

}  // namespace bridge
}  // namespace enhancement
}  // namespace sherpaonnx