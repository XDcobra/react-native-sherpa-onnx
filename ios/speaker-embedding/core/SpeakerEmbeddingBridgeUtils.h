#ifndef SHERPA_ONNX_SPEAKER_EMBEDDING_BRIDGE_UTILS_H
#define SHERPA_ONNX_SPEAKER_EMBEDDING_BRIDGE_UTILS_H

#import <Foundation/Foundation.h>

#include "sherpa-onnx-model-detect.h"

#include <string>

namespace sherpaonnx {
namespace speaker_embedding {
namespace bridge {

NSString *SpeakerEmbeddingKindToNSString(sherpaonnx::SpeakerEmbeddingModelKind kind);

NSDictionary *SpeakerEmbeddingDetectResultToDict(
    const sherpaonnx::SpeakerEmbeddingDetectResult &result
);

std::string ModelTypeOrAuto(NSString *modelType);

}  // namespace bridge
}  // namespace speaker_embedding
}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_SPEAKER_EMBEDDING_BRIDGE_UTILS_H
