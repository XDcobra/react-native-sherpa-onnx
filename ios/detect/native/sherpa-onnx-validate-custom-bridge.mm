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
    if (!requirements.fields.empty()) {
        NSMutableArray *fields = [NSMutableArray arrayWithCapacity:requirements.fields.size()];
        for (const auto &field : requirements.fields) {
            NSMutableDictionary *entry = [NSMutableDictionary dictionary];
            entry[@"key"] = [NSString stringWithUTF8String:field.key.c_str()];
            entry[@"required"] = @(field.required);
            entry[@"kind"] = field.isDirectory ? @"dir" : @"file";
            [fields addObject:entry];
        }
        dict[@"fields"] = fields;
    }
    return dict;
}

}  // namespace bridge
}  // namespace detect
}  // namespace sherpaonnx
