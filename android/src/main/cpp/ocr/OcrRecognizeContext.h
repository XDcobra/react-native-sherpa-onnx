/**
 * Per-recognize progress + cancel sink. Families call Report / ThrowIfCancelled
 * at their own phase names — no engine switch. Unknown phase strings are allowed.
 */
#pragma once

#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>
#include <string_view>

namespace sherpa_onnx {
namespace ocr {

inline constexpr const char* kOcrPhasePreprocess = "preprocess";
inline constexpr const char* kOcrPhasePatch = "patch";
inline constexpr const char* kOcrPhaseVision = "vision";
inline constexpr const char* kOcrPhaseEmbed = "embed";
inline constexpr const char* kOcrPhasePrefill = "prefill";
inline constexpr const char* kOcrPhaseDecode = "decode";
inline constexpr const char* kOcrPhaseDetect = "detect";
inline constexpr const char* kOcrPhaseRecognize = "recognize";
inline constexpr const char* kOcrPhaseParse = "parse";

/** Default native→JS progress coalesce. `0` = unthrottled. */
inline constexpr int kOcrProgressMinIntervalMs = 200;

class OcrCancelled : public std::runtime_error {
 public:
  OcrCancelled() : std::runtime_error("OCR recognize cancelled") {}
};

struct OcrProgressTick {
  std::string phase;
  int done = 0;
  int total = 0;
  int frame_index = 0;
  int frame_count = 1;
};

using OcrProgressFn = std::function<void(const OcrProgressTick&)>;
using OcrCancelFn = std::function<bool()>;

struct OcrRecognizeContext {
  OcrProgressFn progress;
  OcrCancelFn cancel;
  int frame_index = 0;
  int frame_count = 1;
  /** Minimum ms between emitted ticks. `0` = every Report. */
  int progress_min_interval_ms = kOcrProgressMinIntervalMs;

  void Report(std::string_view phase, int done, int total) const;
  void ThrowIfCancelled() const;
  /** Emit done=0 then run fn then done=1 (total=1). Throws if cancelled first. */
  void RunPhase(std::string_view phase, const std::function<void()>& fn) const;

 private:
  mutable std::string last_emitted_phase_;
  mutable int last_emitted_frame_ = -1;
  mutable int64_t last_emit_ms_ = 0;
};

}  // namespace ocr
}  // namespace sherpa_onnx
