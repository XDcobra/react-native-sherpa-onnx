#include "OcrRecognizeContext.h"

#include <chrono>

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

void OcrRecognizeContext::Report(std::string_view phase, int done, int total) const {
  if (!progress) return;
  const std::string phase_str(phase);
  const int64_t now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now().time_since_epoch())
                             .count();
  const bool phase_changed = last_emitted_phase_ != phase_str;
  const bool frame_changed = last_emitted_frame_ != frame_index;
  const bool complete = total > 0 && done >= total;
  const bool first = last_emit_ms_ == 0;
  const bool interval_elapsed =
      progress_min_interval_ms <= 0 || first ||
      (now_ms - last_emit_ms_) >= static_cast<int64_t>(progress_min_interval_ms);
  if (!phase_changed && !frame_changed && !complete && !interval_elapsed) {
    return;
  }
  last_emitted_phase_ = phase_str;
  last_emitted_frame_ = frame_index;
  last_emit_ms_ = now_ms;
  OCR_LOGI("progress phase=%s done=%d total=%d frame=%d/%d", phase_str.c_str(), done, total,
           frame_index, frame_count);
  OcrProgressTick tick;
  tick.phase = phase_str;
  tick.done = done;
  tick.total = total;
  tick.frame_index = frame_index;
  tick.frame_count = frame_count;
  progress(tick);
}

void OcrRecognizeContext::ThrowIfCancelled() const {
  if (cancel && cancel()) {
    throw OcrCancelled();
  }
}

void OcrRecognizeContext::RunPhase(std::string_view phase,
                                   const std::function<void()>& fn) const {
  ThrowIfCancelled();
  Report(phase, 0, 1);
  fn();
  Report(phase, 1, 1);
}

}  // namespace ocr
}  // namespace sherpa_onnx
