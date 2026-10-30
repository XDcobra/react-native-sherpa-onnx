#pragma once

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

class AudioTimeline {
 public:
  void Reserve(size_t n);
  void Append(const AudioPacketEntry& e);
  void AssignImmutable(std::vector<AudioPacketEntry> entries);
  void EvictBefore(int64_t index);

  int64_t IndexAtOrBefore(int64_t tUs) const;
  Status Get(int64_t index, AudioPacketEntry* out) const;
  int64_t size() const;
  bool empty() const { return size() == 0; }
  int64_t startUs() const;
  int64_t endUs() const;
  int64_t firstIndex() const { return firstIndex_; }
  uint64_t generation() const;

 private:
  struct Snapshot {
    std::vector<const std::vector<AudioPacketEntry>*> chunks;
    size_t total = 0;
    int64_t first = 0;
  };
  Snapshot Snap() const;
  bool GetAt(const Snapshot& snap, int64_t absIndex, AudioPacketEntry* out) const;

  mutable std::mutex mu_;
  std::vector<std::vector<AudioPacketEntry>> chunks_;
  std::vector<AudioPacketEntry> current_;
  size_t total_ = 0;
  int64_t firstIndex_ = 0;
  uint64_t generation_ = 0;
  bool immutable_ = false;
  bool ptsWarned_ = false;
  static constexpr size_t kChunk = 4096;
};

}  // namespace video
}  // namespace sherpa_onnx
