#import "sherpa-onnx-unified-detect-bridge.h"
#import "sherpa-onnx-public-language-row-bridge.h"

#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {
namespace detect {
namespace bridge {

NSDictionary *UnifiedDetectResultToDict(const UnifiedModelDetectResult &result) {
    NSMutableArray *detectedModelsArray = [NSMutableArray array];
    for (const auto &model : result.detectedModels) {
        [detectedModelsArray addObject:@{
            @"type": [NSString stringWithUTF8String:model.type.c_str()] ?: @"",
            @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()] ?: @""
        }];
    }

    NSMutableDictionary *dict = [@{
        @"matched": @(result.matched),
        @"success": @(result.success),
        @"isStreaming": @(result.isStreaming),
        @"detectedModels": detectedModelsArray,
    } mutableCopy];

    if (result.isHardwareSpecificUnsupported) {
        dict[@"isHardwareSpecificUnsupported"] = @YES;
    }
    if (!result.category.empty()) {
        dict[@"category"] = [NSString stringWithUTF8String:result.category.c_str()] ?: @"";
    }
    if (!result.modelType.empty()) {
        dict[@"modelType"] = [NSString stringWithUTF8String:result.modelType.c_str()] ?: @"";
    }
    if (!result.error.empty()) {
        dict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()] ?: @"";
    }
    if (!result.quantization.empty()) {
        dict[@"quantization"] = [NSString stringWithUTF8String:result.quantization.c_str()] ?: @"";
    }
    if (!result.sizeTier.empty()) {
        dict[@"sizeTier"] = [NSString stringWithUTF8String:result.sizeTier.c_str()] ?: @"";
    }

    if (!result.languages.empty()) {
        dict[@"languages"] = PublicLanguageRowsToNSArray(result.languages);
    }

    if (!result.detectionSources.empty()) {
        NSMutableArray *sources = [NSMutableArray array];
        for (const auto &source : result.detectionSources) {
            [sources addObject:[NSString stringWithUTF8String:source.c_str()] ?: @""];
        }
        dict[@"detectionSources"] = sources;
    }

    if (!result.paths.empty()) {
        NSMutableDictionary *paths = [NSMutableDictionary dictionary];
        for (const auto &entry : result.paths) {
            if (entry.second.empty()) {
                continue;
            }
            paths[[NSString stringWithUTF8String:entry.first.c_str()] ?: @""] =
                [NSString stringWithUTF8String:entry.second.c_str()] ?: @"";
        }
        if (paths.count > 0) {
            dict[@"paths"] = paths;
        }
    }

    return dict;
}

}  // namespace bridge
}  // namespace detect
}  // namespace sherpaonnx
