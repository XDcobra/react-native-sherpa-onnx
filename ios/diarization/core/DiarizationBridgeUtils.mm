#import "DiarizationBridgeUtils.h"
#import "../../detect/native/sherpa-onnx-public-language-row-bridge.h"

namespace sherpaonnx {
namespace diarization {
namespace bridge {

NSString *DiarizationKindToNSString(sherpaonnx::DiarizationModelKind kind) {
  using K = sherpaonnx::DiarizationModelKind;
  switch (kind) {
    case K::kPyannote:
      return @"pyannote";
    case K::kReverb:
      return @"reverb";
    default:
      return @"unknown";
  }
}

NSDictionary *DiarizationDetectResultToDict(
    const sherpaonnx::DiarizationDetectResult &result
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
    @"modelType": DiarizationKindToNSString(result.selectedKind),
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

  if (!result.paths.model.empty()) {
    dict[@"paths"] = @{
      @"model": [NSString stringWithUTF8String:result.paths.model.c_str()] ?: @""
    };
  }

  if (!result.ok && !result.error.empty()) {
    dict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()]
        ?: @"Diarization model detection failed";
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
}  // namespace diarization
}  // namespace sherpaonnx
