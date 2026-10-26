#include "OcrOrtEnv.h"

#include <onnxruntime_cxx_api.h>

#ifndef OCR_LOG_TAG
#define OCR_LOG_TAG "SherpaOnnx:ocr"
#endif

#if defined(__ANDROID__)
#include <android/log.h>
#define OCR_LOGI(...) __android_log_print(ANDROID_LOG_INFO, OCR_LOG_TAG, __VA_ARGS__)
#else
#include <cstdio>
#define OCR_LOGI(...)             \
  do {                            \
    std::fprintf(stderr, "[SherpaOnnx:ocr] "); \
    std::fprintf(stderr, __VA_ARGS__);         \
    std::fprintf(stderr, "\n");                \
  } while (0)
#endif

namespace sherpa_onnx {
namespace ocr {

Ort::Env& SharedOrtEnv() {
  // Intentionally leaked: default Env is tiny; destroying it at process exit
  // races other statics and leftover ORT TLS.
  static Ort::Env* const env = []() -> Ort::Env* {
    auto* created = new Ort::Env(ORT_LOGGING_LEVEL_WARNING, "sherpa-onnx-ocr");
    OCR_LOGI("shared Ort::Env created (process lifetime)");
    return created;
  }();
  return *env;
}

}  // namespace ocr
}  // namespace sherpa_onnx
