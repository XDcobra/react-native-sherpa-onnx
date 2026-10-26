#pragma once

#ifndef OCR_LOG_TAG
#define OCR_LOG_TAG "SherpaOnnx:ocr"
#endif

#if defined(__ANDROID__)
#include <android/log.h>
#define OCR_LOGI(...) __android_log_print(ANDROID_LOG_INFO, OCR_LOG_TAG, __VA_ARGS__)
#define OCR_LOGW(...) __android_log_print(ANDROID_LOG_WARN, OCR_LOG_TAG, __VA_ARGS__)
#else
#include <cstdio>
#define OCR_LOGI(...)                          \
  do {                                         \
    std::fprintf(stderr, "[SherpaOnnx:ocr] "); \
    std::fprintf(stderr, __VA_ARGS__);         \
    std::fprintf(stderr, "\n");                \
  } while (0)
#define OCR_LOGW(...) OCR_LOGI(__VA_ARGS__)
#endif
