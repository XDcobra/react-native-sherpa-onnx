#import "sherpa-onnx-validate-custom-bridge.h"

namespace sherpaonnx {
namespace detect {
namespace bridge {

NSDictionary *CustomValidationResultToDict(const CustomModelValidationResult &result) {
    NSMutableDictionary *dict = [NSMutableDictionary dictionary];
    dict[@"ok"] = @(result.ok);
    if (!result.error.empty()) {
        dict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()];
    }
    if (!result.missingRequired.empty()) {
        NSMutableArray *missing = [NSMutableArray arrayWithCapacity:result.missingRequired.size()];
        for (const auto &entry : result.missingRequired) {
            [missing addObject:[NSString stringWithUTF8String:entry.c_str()]];
        }
        dict[@"missingRequired"] = missing;
    }
    return dict;
}

NSDictionary *CustomPathRequirementsToDict(const CustomModelPathRequirements &requirements) {
    NSMutableDictionary *dict = [NSMutableDictionary dictionary];
    if (!requirements.required.empty()) {
        NSMutableArray *required = [NSMutableArray arrayWithCapacity:requirements.required.size()];
        for (const auto &entry : requirements.required) {
            [required addObject:[NSString stringWithUTF8String:entry.c_str()]];
        }
        dict[@"required"] = required;
    }
    if (!requirements.optional.empty()) {
        NSMutableArray *optional = [NSMutableArray arrayWithCapacity:requirements.optional.size()];
        for (const auto &entry : requirements.optional) {
            [optional addObject:[NSString stringWithUTF8String:entry.c_str()]];
        }
        dict[@"optional"] = optional;
    }
    return dict;
}

}  // namespace bridge
}  // namespace detect
}  // namespace sherpaonnx
