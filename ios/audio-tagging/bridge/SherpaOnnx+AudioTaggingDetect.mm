#import "../../SherpaOnnx.h"
#import "../../detect/native/sherpa-onnx-public-language-row-bridge.h"

#include "sherpa-onnx-model-detect.h"

#include <optional>
#include <string>

namespace {

std::optional<std::string> OptionalUtf8(NSString *value) {
  if (value == nil || [value length] == 0) return std::nullopt;
  return std::string([value UTF8String]);
}

NSString *String(const std::string &value) {
  return [NSString stringWithUTF8String:value.c_str()] ?: @"";
}

NSString *AudioTaggingKindToNSString(sherpaonnx::AudioTaggingModelKind kind) {
  switch (kind) {
    case sherpaonnx::AudioTaggingModelKind::kCed:
      return @"ced";
    case sherpaonnx::AudioTaggingModelKind::kZipformer:
      return @"zipformer";
    default:
      return @"unknown";
  }
}

}  // namespace

@implementation SherpaOnnx (AudioTaggingDetect)

- (void)detectAudioTaggingModel:(NSString *)modelDir
                      assetName:(NSString * _Nullable)assetName
                      modelType:(NSString * _Nullable)modelType
                   quantization:(NSString * _Nullable)quantization
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  @try {
    const auto result = sherpaonnx::DetectAudioTaggingModel(
        OptionalUtf8(modelDir),
        OptionalUtf8(assetName),
        modelType != nil && [modelType length] > 0
            ? std::string([modelType UTF8String]) : "auto",
        quantization != nil ? std::string([quantization UTF8String]) : "");

    NSMutableArray *models = [NSMutableArray array];
    for (const auto &model : result.detectedModels) {
      [models addObject:@{@"type": String(model.type), @"modelDir": String(model.modelDir)}];
    }
    NSMutableDictionary *dict = [@{
      @"success": @(result.ok),
      @"isStreaming": @(false),
      @"detectedModels": models,
      @"modelType": AudioTaggingKindToNSString(result.selectedKind)
    } mutableCopy];
    if (!result.error.empty()) dict[@"error"] = String(result.error);
    if (!result.quantization.empty()) dict[@"quantization"] = String(result.quantization);
    if (!result.derivedLanguages.empty()) {
      dict[@"languages"] =
          sherpaonnx::detect::bridge::PublicLanguageRowsToNSArray(result.derivedLanguages);
    }
    if (!result.detectionSources.empty()) {
      NSMutableArray *sources = [NSMutableArray array];
      for (const auto source : result.detectionSources) {
        [sources addObject:String(sherpaonnx::DetectionSourceToLiteral(source))];
      }
      dict[@"detectionSources"] = sources;
    }
    NSMutableDictionary *paths = [NSMutableDictionary dictionary];
    if (!result.paths.model.empty()) paths[@"model"] = String(result.paths.model);
    if (!result.paths.labels.empty()) paths[@"labels"] = String(result.paths.labels);
    if ([paths count] > 0) dict[@"paths"] = paths;
    resolve(dict);
  } @catch (NSException *exception) {
    reject(@"AUDIO_TAGGING_DETECT_ERROR",
           [NSString stringWithFormat:@"Audio tagging detect failed: %@", exception.reason],
           nil);
  }
}

@end
