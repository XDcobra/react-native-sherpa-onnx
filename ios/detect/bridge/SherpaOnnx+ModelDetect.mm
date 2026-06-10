#import "../../SherpaOnnx.h"

#include "../native/sherpa-onnx-unified-detect-bridge.h"
#include "../native/sherpa-onnx-validate-custom-bridge.h"
#include "sherpa-onnx-model-detect-unified.h"
#include "sherpa-onnx-validate-custom.h"

#include <map>
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

std::map<std::string, std::string> StringMapFromNSDictionary(NSDictionary *dict) {
    std::map<std::string, std::string> out;
    if (![dict isKindOfClass:[NSDictionary class]]) {
        return out;
    }
    for (NSString *key in dict) {
        id value = dict[key];
        if ([value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0) {
            out[std::string([key UTF8String])] = std::string([(NSString *)value UTF8String]);
        }
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

- (void)validateCustomModelPaths:(NSString *)category
                       modelType:(NSString *)modelType
                           paths:(NSDictionary *)paths
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
    @try {
        if (category == nil || [category length] == 0 ||
            modelType == nil || [modelType length] == 0) {
            reject(@"VALIDATE_ERROR", @"category and modelType are required", nil);
            return;
        }
        auto pathMap = StringMapFromNSDictionary(paths);
        auto result = sherpaonnx::ValidateCustomModelPaths(
            std::string([category UTF8String]),
            std::string([modelType UTF8String]),
            pathMap,
            "custom");
        resolve(sherpaonnx::detect::bridge::CustomValidationResultToDict(result));
    } @catch (NSException *exception) {
        reject(@"VALIDATE_ERROR",
               [NSString stringWithFormat:@"Custom model path validation failed: %@", exception.reason],
               nil);
    }
}

- (void)getCustomModelPathRequirements:(NSString *)category
                             modelType:(NSString *)modelType
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
    @try {
        if (category == nil || [category length] == 0 ||
            modelType == nil || [modelType length] == 0) {
            reject(@"VALIDATE_ERROR", @"category and modelType are required", nil);
            return;
        }
        auto requirements = sherpaonnx::GetCustomModelPathRequirements(
            std::string([category UTF8String]),
            std::string([modelType UTF8String]));
        resolve(sherpaonnx::detect::bridge::CustomPathRequirementsToDict(requirements));
    } @catch (NSException *exception) {
        reject(@"VALIDATE_ERROR",
               [NSString stringWithFormat:@"Custom model path requirements failed: %@", exception.reason],
               nil);
    }
}

@end
