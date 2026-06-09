#ifndef SHERPA_ONNX_PUBLIC_LANGUAGE_ROW_BRIDGE_H
#define SHERPA_ONNX_PUBLIC_LANGUAGE_ROW_BRIDGE_H

#import <Foundation/Foundation.h>

#include "sherpa-onnx-model-detect.h"

#include <vector>

namespace sherpaonnx {
namespace detect {
namespace bridge {

NSArray *PublicLanguageRowsToNSArray(
    const std::vector<PublicLanguageRow> &rows);

}  // namespace bridge
}  // namespace detect
}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_PUBLIC_LANGUAGE_ROW_BRIDGE_H
