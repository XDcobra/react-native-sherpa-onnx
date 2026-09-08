#import "LanguageIdBridgeUtils.h"
#import "../../detect/native/sherpa-onnx-public-language-row-bridge.h"

namespace sherpaonnx {
namespace language_id {
namespace bridge {

NSString *LanguageIdKindToNSString(sherpaonnx::LanguageIdModelKind kind) {
  using K = sherpaonnx::LanguageIdModelKind;
  switch (kind) {
    case K::kWhisper:
      return @"whisper";
    default:
      return @"unknown";
  }
}

NSDictionary *LanguageIdDetectResultToDict(
    const sherpaonnx::LanguageIdDetectResult &result
) {
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
    @"modelType": LanguageIdKindToNSString(result.selectedKind),
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

  NSMutableDictionary *pathsDict = [NSMutableDictionary dictionary];
  if (!result.paths.encoder.empty()) {
    pathsDict[@"encoder"] = [NSString stringWithUTF8String:result.paths.encoder.c_str()] ?: @"";
  }
  if (!result.paths.decoder.empty()) {
    pathsDict[@"decoder"] = [NSString stringWithUTF8String:result.paths.decoder.c_str()] ?: @"";
  }
  if ([pathsDict count] > 0) {
    dict[@"paths"] = pathsDict;
  }

  if (!result.ok && !result.error.empty()) {
    dict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()]
        ?: @"Language ID model detection failed";
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
}  // namespace language_id
}  // namespace sherpaonnx
