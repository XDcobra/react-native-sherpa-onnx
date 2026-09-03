#ifndef SHERPA_ONNX_SPEAKER_EMBEDDING_DETECT_WRAPPER_H
#define SHERPA_ONNX_SPEAKER_EMBEDDING_DETECT_WRAPPER_H

#include <jni.h>

#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

jobject SpeakerEmbeddingDetectResultToJava(
    JNIEnv* env,
    const SpeakerEmbeddingDetectResult& result
);

} // namespace sherpaonnx

#endif // SHERPA_ONNX_SPEAKER_EMBEDDING_DETECT_WRAPPER_H
