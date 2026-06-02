#import "../../SherpaOnnx.h"

#include "../native/sherpa-onnx-unified-detect-bridge.h"
#include "sherpa-onnx-model-detect-unified.h"

#include <optional>
#include <string>
#include <vector>

namespace {

std::optional<std::string> OptionalUtf8String(NSString *value) {
    if (value == nil || [value length] == 0) {
        return std::nullopt;
    }
    return std::string([value UTF8String]);
}

std::vector<sherpaonnx::UnifiedModelDetectInput> InputsFromNSArray(NSArray *inputs) {
    std::vector<sherpaonnx::UnifiedModelDetectInput> out;
    if (inputs == nil) {
        return out;
    }
    for (id item in inputs) {
        if (![item isKindOfClass:[NSDictionary class]]) {
            continue;
        }
        NSDictionary *entry = (NSDictionary *)item;
        sherpaonnx::UnifiedModelDetectInput input;
        input.model_dir = OptionalUtf8String(entry[@"modelDir"]);
        input.asset_name = OptionalUtf8String(entry[@"assetName"]);
        out.push_back(std::move(input));
    }
    return out;
}

}  // namespace

@implementation SherpaOnnx (ModelDetect)

- (void)detectModel:(NSString *)modelDir
          assetName:(NSString * _Nullable)assetName
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
    @try {
        auto modelDirOpt = OptionalUtf8String(modelDir);
        auto assetNameOpt = OptionalUtf8String(assetName);
        auto result = sherpaonnx::DetectModel(modelDirOpt, assetNameOpt);
        resolve(sherpaonnx::detect::bridge::UnifiedDetectResultToDict(result));
    } @catch (NSException *exception) {
        reject(@"DETECT_ERROR",
               [NSString stringWithFormat:@"Unified model detect failed: %@", exception.reason],
               nil);
    }
}

- (void)detectModelsBatch:(NSArray *)inputs
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
    @try {
        auto nativeInputs = InputsFromNSArray(inputs);
        auto results = sherpaonnx::DetectModelsBatch(nativeInputs);
        NSMutableArray *out = [NSMutableArray arrayWithCapacity:results.size()];
        for (const auto &result : results) {
            [out addObject:sherpaonnx::detect::bridge::UnifiedDetectResultToDict(result)];
        }
        resolve(out);
    } @catch (NSException *exception) {
        reject(@"DETECT_ERROR",
               [NSString stringWithFormat:@"Unified batch model detect failed: %@", exception.reason],
               nil);
    }
}

@end
