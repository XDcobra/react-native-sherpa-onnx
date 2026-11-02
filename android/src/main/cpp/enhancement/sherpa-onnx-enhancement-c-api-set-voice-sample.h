#ifndef SHERPA_ONNX_ENHANCEMENT_C_API_SET_VOICE_SAMPLE_H
#define SHERPA_ONNX_ENHANCEMENT_C_API_SET_VOICE_SAMPLE_H

#include "sherpa-onnx/c-api/c-api.h"

#ifdef __cplusplus
extern "C" {
#endif

/* SetVoiceSample ships after sherpa-onnx 2.0.1. Identical re-declaration is
 * valid once the matching prebuilt header is present. */
SHERPA_ONNX_API int32_t SherpaOnnxOfflineSpeechDenoiserSetVoiceSample(
    const SherpaOnnxOfflineSpeechDenoiser *sd, const float *samples, int32_t n,
    int32_t sample_rate);
SHERPA_ONNX_API int32_t SherpaOnnxOnlineSpeechDenoiserSetVoiceSample(
    const SherpaOnnxOnlineSpeechDenoiser *sd, const float *samples, int32_t n,
    int32_t sample_rate);

#ifdef __cplusplus
}
#endif

#endif  // SHERPA_ONNX_ENHANCEMENT_C_API_SET_VOICE_SAMPLE_H
