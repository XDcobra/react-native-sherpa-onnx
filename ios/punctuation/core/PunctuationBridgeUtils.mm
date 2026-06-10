#import "PunctuationBridgeUtils.h"

namespace sherpaonnx {
namespace punctuation {
namespace bridge {

NSString *PunctuationKindToNSString(sherpaonnx::PunctuationModelKind kind) {
  using K = sherpaonnx::PunctuationModelKind;
  switch (kind) {
    case K::kCtTransformer:
      return @"ct_transformer";
    case K::kCnnBilstm:
      return @"cnn_bilstm";
    default:
      return @"unknown";
  }
}

NSDictionary *PunctuationDetectResultToDict(const sherpaonnx::PunctuationDetectResult& result) {
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
    @"modelType": PunctuationKindToNSString(result.selectedKind),
  } mutableCopy];

  if (!result.detectionSources.empty()) {
    NSMutableArray *sources = [NSMutableArray array];
    for (const auto source : result.detectionSources) {
      [sources addObject:[NSString stringWithUTF8String:sherpaonnx::DetectionSourceToLiteral(source)] ?: @""];
    }
    dict[@"detectionSources"] = sources;
  }

  if (!result.derivedLanguages.empty()) {
    NSMutableArray *languages = [NSMutableArray array];
    for (const auto &id : result.derivedLanguages) {
      [languages addObject:[NSString stringWithUTF8String:id.c_str()] ?: @""];
    }
    dict[@"languages"] = languages;
  }

  if (!result.quantization.empty()) {
    dict[@"quantization"] = [NSString stringWithUTF8String:result.quantization.c_str()] ?: @"";
  }

  NSMutableDictionary *paths = [NSMutableDictionary dictionary];
  if (!result.paths.ct_transformer.empty()) {
    paths[@"ct_transformer"] = [NSString stringWithUTF8String:result.paths.ct_transformer.c_str()];
  }
  if (!result.paths.cnn_bilstm.empty()) {
    paths[@"cnn_bilstm"] = [NSString stringWithUTF8String:result.paths.cnn_bilstm.c_str()];
  }
  if (!result.paths.bpe_vocab.empty()) {
    paths[@"bpe_vocab"] = [NSString stringWithUTF8String:result.paths.bpe_vocab.c_str()];
  }
  if (paths.count > 0) {
    dict[@"paths"] = paths;
  }

  if (!result.ok && !result.error.empty()) {
    dict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()] ?: @"Punctuation model detection failed";
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
}  // namespace punctuation
}  // namespace sherpaonnx
