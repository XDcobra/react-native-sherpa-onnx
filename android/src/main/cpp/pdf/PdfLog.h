#pragma once

#if defined(__ANDROID__)
#include <android/log.h>
#define PDF_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:pdf", __VA_ARGS__)
#define PDF_LOGW(...) \
  __android_log_print(ANDROID_LOG_WARN, "SherpaOnnx:pdf", __VA_ARGS__)
#else
#include <cstdio>
#define PDF_LOGI(...)                         \
  do {                                        \
    std::fprintf(stderr, "[SherpaOnnx:pdf] "); \
    std::fprintf(stderr, __VA_ARGS__);        \
    std::fprintf(stderr, "\n");               \
  } while (0)
#define PDF_LOGW(...)                         \
  do {                                        \
    std::fprintf(stderr, "[SherpaOnnx:pdf] "); \
    std::fprintf(stderr, __VA_ARGS__);        \
    std::fprintf(stderr, "\n");               \
  } while (0)
#endif
