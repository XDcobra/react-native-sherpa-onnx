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
namespace video {

// Runtime info/debug gate. Errors always log. TS sets this from __DEV__.
inline bool& VideoLogEnabled() {
  static bool enabled = [] {
    const char* env = std::getenv("SHERPA_VIDEO_DEBUG");
    return env != nullptr && env[0] != '\0' && std::strcmp(env, "0") != 0;
  }();
  return enabled;
}

inline void SetVideoLogEnabled(bool on) { VideoLogEnabled() = on; }

inline void VideoLogPrint(const char* tag, const char* level, const char* fmt,
                          va_list ap) {
#if defined(__ANDROID__)
  android_LogPriority prio = ANDROID_LOG_INFO;
  if (level[0] == 'E') {
    prio = ANDROID_LOG_ERROR;
  } else if (level[0] == 'W') {
    prio = ANDROID_LOG_WARN;
  } else if (level[0] == 'D') {
    prio = ANDROID_LOG_DEBUG;
  }
  __android_log_vprint(prio, tag, fmt, ap);
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
  os_log_with_type(OS_LOG_DEFAULT, t, "[%{public}s] %{public}s", tag, buf);
#else
  fprintf(stderr, "[%s][%s] ", tag, level);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
#endif
}

inline void VideoLog(const char* tag, const char* level, const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  VideoLogPrint(tag, level, fmt, ap);
  va_end(ap);
}

}  // namespace video
}  // namespace sherpa_onnx

#define VIDEO_LOGE(...) \
  ::sherpa_onnx::video::VideoLog("SherpaOnnx:video", "E", __VA_ARGS__)
#define VIDEO_LOGW(...) \
  ::sherpa_onnx::video::VideoLog("SherpaOnnx:video", "W", __VA_ARGS__)
#define VIDEO_LOGI(...)                                          \
  do {                                                           \
    if (::sherpa_onnx::video::VideoLogEnabled()) {               \
      ::sherpa_onnx::video::VideoLog("SherpaOnnx:video", "I",     \
                                     __VA_ARGS__);               \
    }                                                            \
  } while (0)
#define VIDEO_LOGD(...)                                          \
  do {                                                           \
    if (::sherpa_onnx::video::VideoLogEnabled()) {               \
      ::sherpa_onnx::video::VideoLog("SherpaOnnx:video", "D",     \
                                     __VA_ARGS__);               \
    }                                                            \
  } while (0)
