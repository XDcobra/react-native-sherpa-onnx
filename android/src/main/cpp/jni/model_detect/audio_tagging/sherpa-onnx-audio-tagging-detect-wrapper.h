#ifndef SHERPA_ONNX_AUDIO_TAGGING_DETECT_WRAPPER_H
#define SHERPA_ONNX_AUDIO_TAGGING_DETECT_WRAPPER_H

#include <jni.h>

#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

jobject AudioTaggingDetectResultToJava(JNIEnv* env, const AudioTaggingDetectResult& result);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_AUDIO_TAGGING_DETECT_WRAPPER_H
