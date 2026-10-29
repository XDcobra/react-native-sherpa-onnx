#pragma once

#include <cstdint>
#include <mutex>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

class MemoryBudget {
 public:
  static MemoryBudget& Instance();

  void Configure(VideoRamClass ramClass);
  void SetLimitBytes(int64_t bytes);  // tests / init override
  int64_t limitBytes() const;
  int64_t usedBytes() const;
  VideoRamClass ramClass() const { return ramClass_; }

  /** Returns false if adding would exceed the limit (pinned still counts). */
  bool TryReserve(int64_t bytes);
  void Release(int64_t bytes);
  void ResetUsedForTest();

  static int64_t DefaultDecodedLimit(VideoRamClass c);
  static int64_t DefaultRingMaxBytes(VideoRamClass c);
  static VideoRamClass ClassifyRam(uint64_t totalRamBytes);

 private:
  MemoryBudget() = default;
  mutable std::mutex mu_;
  int64_t limit_ = DefaultDecodedLimit(VideoRamClass::Mid);
  int64_t used_ = 0;
  VideoRamClass ramClass_ = VideoRamClass::Mid;
};

}  // namespace video
}  // namespace sherpa_onnx
