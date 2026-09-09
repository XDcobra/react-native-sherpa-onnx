#import "../../SherpaOnnx.h"

#include "../core/LanguageIdBridgeUtils.h"

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

@implementation SherpaOnnx (LanguageId)

- (void)detectLanguageIdModel:(NSString *)modelDir
                    assetName:(NSString * _Nullable)assetName
                    modelType:(NSString * _Nullable)modelType
                 quantization:(NSString * _Nullable)quantization
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  @try {
    auto modelDirOpt = OptionalUtf8String(modelDir);
    auto assetNameOpt = OptionalUtf8String(assetName);
    std::string quantStr =
        (quantization != nil && [quantization length] > 0) ? [quantization UTF8String] : "";
    std::string modelTypeStr =
        sherpaonnx::language_id::bridge::ModelTypeOrAuto(modelType);

    auto result =
        sherpaonnx::DetectLanguageIdModel(modelDirOpt, assetNameOpt, modelTypeStr, quantStr);
    resolve(sherpaonnx::language_id::bridge::LanguageIdDetectResultToDict(result));
  } @catch (NSException *exception) {
    reject(@"LANGUAGE_ID_DETECT_ERROR",
           [NSString stringWithFormat:@"Language ID detect failed: %@", exception.reason],
           nil);
  }
}

@end
