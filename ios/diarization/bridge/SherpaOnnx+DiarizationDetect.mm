#import "../../SherpaOnnx.h"

#include "../core/DiarizationBridgeUtils.h"

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

@implementation SherpaOnnx (Diarization)

- (void)detectDiarizationModel:(NSString *)modelDir
                     assetName:(NSString * _Nullable)assetName
                     modelType:(NSString * _Nullable)modelType
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  @try {
    auto modelDirOpt = OptionalUtf8String(modelDir);
    auto assetNameOpt = OptionalUtf8String(assetName);
    std::string modelTypeStr =
        sherpaonnx::diarization::bridge::ModelTypeOrAuto(modelType);

    auto result =
        sherpaonnx::DetectDiarizationModel(modelDirOpt, assetNameOpt, modelTypeStr);
    resolve(sherpaonnx::diarization::bridge::DiarizationDetectResultToDict(result));
  } @catch (NSException *exception) {
    reject(@"DIARIZATION_DETECT_ERROR",
           [NSString stringWithFormat:@"Diarization detect failed: %@", exception.reason],
           nil);
  }
}

@end
