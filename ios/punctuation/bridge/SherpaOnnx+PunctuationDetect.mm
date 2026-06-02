#import "../../SherpaOnnx.h"

#include "../core/PunctuationBridgeUtils.h"

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

@implementation SherpaOnnx (Punctuation)

- (void)detectPunctuationModel:(NSString *)modelDir
                      assetName:(NSString * _Nullable)assetName
                      modelType:(NSString * _Nullable)modelType
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  @try {
    auto modelDirOpt = OptionalUtf8String(modelDir);
    auto assetNameOpt = OptionalUtf8String(assetName);
    std::string modelTypeStr = sherpaonnx::punctuation::bridge::ModelTypeOrAuto(modelType);

    auto result = sherpaonnx::DetectPunctuationModel(modelDirOpt, assetNameOpt, modelTypeStr);
    resolve(sherpaonnx::punctuation::bridge::PunctuationDetectResultToDict(result));
  } @catch (NSException *exception) {
    reject(@"PUNCT_DETECT_ERROR",
           [NSString stringWithFormat:@"Punctuation detect failed: %@", exception.reason],
           nil);
  }
}

@end
