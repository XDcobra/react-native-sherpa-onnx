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

}  // namespace

@implementation SherpaOnnx (KwsDetect)

- (void)detectKwsModel:(NSString *)modelDir
             assetName:(NSString * _Nullable)assetName
             modelType:(NSString * _Nullable)modelType
          quantization:(NSString * _Nullable)quantization
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  @try {
    const auto result = sherpaonnx::DetectKwsModel(
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
      @"isStreaming": @(result.isStreaming),
      @"detectedModels": models,
      @"modelType": result.selectedKind == sherpaonnx::KwsModelKind::kTransducer
          ? @"transducer" : @"unknown"
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
    if (!result.paths.encoder.empty()) paths[@"encoder"] = String(result.paths.encoder);
    if (!result.paths.decoder.empty()) paths[@"decoder"] = String(result.paths.decoder);
    if (!result.paths.joiner.empty()) paths[@"joiner"] = String(result.paths.joiner);
    if (!result.paths.tokens.empty()) paths[@"tokens"] = String(result.paths.tokens);
    if (!result.paths.keywords.empty()) paths[@"keywords"] = String(result.paths.keywords);
    if ([paths count] > 0) dict[@"paths"] = paths;
    resolve(dict);
  } @catch (NSException *exception) {
    reject(@"KWS_DETECT_ERROR",
           [NSString stringWithFormat:@"KWS detect failed: %@", exception.reason],
           nil);
  }
}

@end
