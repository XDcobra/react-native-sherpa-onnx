#pragma once

#include <cstdint>
#include <mutex>
#include <vector>

#include "VideoTypes.h"
#include "core/Timeline.h"

namespace sherpa_onnx {
namespace video {

class EncodedPacketRing {
 public:
  void Configure(int64_t ringSeconds, int64_t ringMaxBytes);

  /** Drops packets until the first keyframe (counted). */
  Status Append(const EncodedPacket& pkt, Timeline* timeline);

  Status Read(int64_t presentationIndex, EncodedPacket* out) const;
  bool Contains(int64_t presentationIndex) const;
  int64_t firstIndex() const;
  int64_t lastIndex() const;
  int64_t byteSize() const;
  int64_t droppedBeforeKey() const { return droppedBeforeKey_; }
  int64_t evictedFrames() const { return evictedFrames_; }
  TimeRange rangeUs() const;
  void Clear();
  /** Evict whole GOPs until newest GOP remains. */
  void TrimToNewestGop();

 private:
  void EvictLocked(int64_t keepSeconds, int64_t keepBytes);

  mutable std::mutex mu_;
  std::vector<EncodedPacket> packets_;  // presentation-aligned with timeline
  int64_t firstIndex_ = 0;
  int64_t bytes_ = 0;
  int64_t ringSeconds_ = 10;
  int64_t ringMaxBytes_ = 32LL * 1024 * 1024;
  int64_t droppedBeforeKey_ = 0;
  int64_t evictedFrames_ = 0;
  bool seenKey_ = false;
};

}  // namespace video
}  // namespace sherpa_onnx
