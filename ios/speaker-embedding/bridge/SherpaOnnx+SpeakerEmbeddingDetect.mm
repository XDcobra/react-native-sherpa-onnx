#import "../../SherpaOnnx.h"

#include "../core/SpeakerEmbeddingBridgeUtils.h"

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

@implementation SherpaOnnx (SpeakerEmbedding)

- (void)detectSpeakerEmbeddingModel:(NSString *)modelDir
                          assetName:(NSString * _Nullable)assetName
                          modelType:(NSString * _Nullable)modelType
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  @try {
    auto modelDirOpt = OptionalUtf8String(modelDir);
    auto assetNameOpt = OptionalUtf8String(assetName);
    std::string modelTypeStr =
        sherpaonnx::speaker_embedding::bridge::ModelTypeOrAuto(modelType);

    auto result =
        sherpaonnx::DetectSpeakerEmbeddingModel(modelDirOpt, assetNameOpt, modelTypeStr);
    resolve(sherpaonnx::speaker_embedding::bridge::SpeakerEmbeddingDetectResultToDict(result));
  } @catch (NSException *exception) {
    reject(@"SPEAKER_EMBEDDING_DETECT_ERROR",
           [NSString stringWithFormat:@"Speaker embedding detect failed: %@", exception.reason],
           nil);
  }
}

@end
