#import "../../SherpaOnnx.h"

#include "sherpa-onnx-model-detect.h"
#import "../../detect/native/sherpa-onnx-public-language-row-bridge.h"

#include <optional>
#include <string>

namespace {

std::optional<std::string> OptionalUtf8String(NSString *value) {
  if (value == nil || [value length] == 0) {
    return std::nullopt;
  }
  return std::string([value UTF8String]);
}

NSString *SeparationKindToNSString(sherpaonnx::SeparationModelKind kind) {
  using K = sherpaonnx::SeparationModelKind;
  switch (kind) {
    case K::kSpleeter:
      return @"spleeter";
    case K::kUvr:
      return @"uvr";
    default:
      return @"unknown";
  }
}

NSDictionary *SeparationDetectResultToDict(const sherpaonnx::SeparationDetectResult &result) {
  NSMutableArray *detectedModelsArray = [NSMutableArray array];
  for (const auto &model : result.detectedModels) {
    [detectedModelsArray addObject:@{
      @"type": [NSString stringWithUTF8String:model.type.c_str()] ?: @"",
      @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()] ?: @""
    }];
  }

  NSMutableDictionary *dict = [@{
    @"success": @(result.ok),
    @"detectedModels": detectedModelsArray,
    @"modelType": SeparationKindToNSString(result.selectedKind),
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

  NSMutableDictionary *paths = [NSMutableDictionary dictionary];
  if (!result.paths.vocals.empty()) {
    paths[@"vocals"] = [NSString stringWithUTF8String:result.paths.vocals.c_str()] ?: @"";
  }
  if (!result.paths.accompaniment.empty()) {
    paths[@"accompaniment"] =
        [NSString stringWithUTF8String:result.paths.accompaniment.c_str()] ?: @"";
  }
  if (!result.paths.model.empty()) {
    paths[@"model"] = [NSString stringWithUTF8String:result.paths.model.c_str()] ?: @"";
  }
  if (paths.count > 0) {
    dict[@"paths"] = paths;
  }

  if (!result.ok && !result.error.empty()) {
    dict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()]
        ?: @"Separation model detection failed";
  }

  return dict;
}

std::string ModelTypeOrAuto(NSString *modelType) {
  if (modelType == nil || [modelType length] == 0) {
    return "auto";
  }
  return std::string([modelType UTF8String]);
}

}  // namespace

@implementation SherpaOnnx (Separation)

- (void)detectSeparationModel:(NSString *)modelDir
                    assetName:(NSString * _Nullable)assetName
                    modelType:(NSString * _Nullable)modelType
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  @try {
    auto modelDirOpt = OptionalUtf8String(modelDir);
    auto assetNameOpt = OptionalUtf8String(assetName);
    std::string modelTypeStr = ModelTypeOrAuto(modelType);

    auto result = sherpaonnx::DetectSeparationModel(modelDirOpt, assetNameOpt, modelTypeStr);
    resolve(SeparationDetectResultToDict(result));
  } @catch (NSException *exception) {
    reject(@"SEPARATION_DETECT_ERROR",
           [NSString stringWithFormat:@"Separation detect failed: %@", exception.reason],
           nil);
  }
}

@end
