#pragma once

#include <cstdint>
#include <mutex>
#include <vector>

#include "VideoTypes.h"
#include "audio/AudioTimeline.h"

namespace sherpa_onnx {
namespace video {

class AudioPacketRing {
 public:
  void Configure(int64_t ringSeconds, int64_t ringMaxBytes);
  Status Append(const EncodedPacket& pkt, AudioTimeline* timeline);
  /** Drop packets with pts < keepStartUs (aligned to video ring start). */
  void EvictBefore(int64_t keepStartUs);
  Status Read(int64_t index, EncodedPacket* out) const;
  bool Contains(int64_t index) const;
  int64_t firstIndex() const;
  int64_t lastIndex() const;
  TimeRange rangeUs() const;
  void Clear();
  int64_t byteSize() const { return bytes_; }

 private:
  mutable std::mutex mu_;
  std::vector<EncodedPacket> packets_;
  int64_t firstIndex_ = 0;
  int64_t bytes_ = 0;
  int64_t ringSeconds_ = 10;
  int64_t ringMaxBytes_ = 8LL * 1024 * 1024;
};

}  // namespace video
}  // namespace sherpa_onnx
