#pragma once

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#if defined(__ANDROID__)
#include <android/log.h>
#elif defined(__APPLE__)
#include <os/log.h>
#endif

namespace sherpa_onnx {
namespace codec {

inline bool& CodecLogEnabled() {
  static bool enabled = [] {
    const char* env = std::getenv("SHERPA_CODEC_DEBUG");
    if (env != nullptr && env[0] != '\0' && std::strcmp(env, "0") != 0) {
      return true;
    }
    env = std::getenv("SHERPA_VIDEO_DEBUG");
    return env != nullptr && env[0] != '\0' && std::strcmp(env, "0") != 0;
  }();
  return enabled;
}

inline void SetCodecLogEnabled(bool on) { CodecLogEnabled() = on; }

inline void CodecLogPrint(const char* level, const char* fmt, va_list ap) {
#if defined(__ANDROID__)
  android_LogPriority prio = ANDROID_LOG_INFO;
  if (level[0] == 'E') {
    prio = ANDROID_LOG_ERROR;
  } else if (level[0] == 'W') {
    prio = ANDROID_LOG_WARN;
  } else if (level[0] == 'D') {
    prio = ANDROID_LOG_DEBUG;
  }
  __android_log_vprint(prio, "SherpaOnnxCodec", fmt, ap);
#elif defined(__APPLE__)
  os_log_type_t t = OS_LOG_TYPE_INFO;
  if (level[0] == 'E') {
    t = OS_LOG_TYPE_ERROR;
  } else if (level[0] == 'W') {
    t = OS_LOG_TYPE_DEFAULT;
  } else if (level[0] == 'D') {
    t = OS_LOG_TYPE_DEBUG;
  }
  char buf[1024];
  vsnprintf(buf, sizeof(buf), fmt, ap);
  os_log_with_type(OS_LOG_DEFAULT, t, "[SherpaOnnxCodec] %{public}s", buf);
#else
  fprintf(stderr, "[SherpaOnnxCodec][%s] ", level);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
#endif
}

inline void CodecLog(const char* level, const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  CodecLogPrint(level, fmt, ap);
  va_end(ap);
}

}  // namespace codec
}  // namespace sherpa_onnx

#define CODEC_LOGE(...) \
  ::sherpa_onnx::codec::CodecLog("E", __VA_ARGS__)
#define CODEC_LOGW(...) \
  ::sherpa_onnx::codec::CodecLog("W", __VA_ARGS__)
#define CODEC_LOGI(...)                                          \
  do {                                                           \
    if (::sherpa_onnx::codec::CodecLogEnabled()) {               \
      ::sherpa_onnx::codec::CodecLog("I", __VA_ARGS__);          \
    }                                                            \
  } while (0)
