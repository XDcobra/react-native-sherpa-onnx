#ifndef SHERPA_ONNX_LANGUAGE_ID_BRIDGE_UTILS_H
#define SHERPA_ONNX_LANGUAGE_ID_BRIDGE_UTILS_H

#import <Foundation/Foundation.h>

#include "sherpa-onnx-model-detect.h"

#include <string>

namespace sherpaonnx {
namespace language_id {
namespace bridge {

NSString *LanguageIdKindToNSString(sherpaonnx::LanguageIdModelKind kind);

NSDictionary *LanguageIdDetectResultToDict(
    const sherpaonnx::LanguageIdDetectResult &result
);

std::string ModelTypeOrAuto(NSString *modelType);

}  // namespace bridge
}  // namespace language_id
}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_LANGUAGE_ID_BRIDGE_UTILS_H
