#pragma once

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

/**
 * Presentation-ordered view of samples. Offline: immutable after open.
 * Live: append-only in chunked segments so readers never see reallocation.
 */
class Timeline {
 public:
  Timeline() = default;

  void Reserve(size_t n);
  void Append(const SampleEntry& sample);  // live path; thread-safe
  void AssignImmutable(std::vector<SampleEntry> presentationOrdered);

  int64_t frameCount() const;
  bool empty() const { return frameCount() == 0; }

  Status Get(int64_t presentationIndex, SampleEntry* out) const;
  /** Frame whose [pts_i, pts_{i+1}) contains t. Last frame if t == end. */
  int64_t SampleAtPts(int64_t tUs) const;
  /** Presentation index of the next (`dir>0`) or previous (`dir<0`) frame.
   *  Clamps to [0, n-1]. Sets *atEdge when the neighbor does not exist. */
  int64_t NeighborSample(int64_t tUs, int dir, bool* atEdge) const;
  int64_t KeyframeAtOrBefore(int64_t sampleIdx) const;
  int64_t ClosestKeyframe(int64_t tUs) const;
  std::vector<int64_t> KeyframeTimes(int64_t fromUs, int64_t toUs,
                                     size_t maxCount) const;
  int64_t startUs() const;
  int64_t endUs() const;  // last pts + estimated duration of last frame

  /** Decode-order index of presentation sample i (identity if dts==pts). */
  int64_t DecodeIndexOf(int64_t presentationIndex) const;
  /** Presentation index of decode-order sample i. */
  int64_t PresentationOfDecode(int64_t decodeIndex) const;

  uint64_t generation() const;

 private:
  struct Snapshot {
    std::vector<const std::vector<SampleEntry>*> chunks;
    size_t total = 0;
    uint64_t generation = 0;
  };
  Snapshot Snap() const;
  bool GetAt(const Snapshot& snap, int64_t i, SampleEntry* out) const;
  void RebuildDecodeOrderLocked();

  mutable std::mutex mu_;
  std::vector<std::vector<SampleEntry>> chunks_;
  std::vector<SampleEntry> current_;
  mutable std::vector<int64_t> decodeToPres_;
  size_t total_ = 0;
  uint64_t generation_ = 0;
  bool immutable_ = false;
  static constexpr size_t kChunk = 1024;
};

}  // namespace video
}  // namespace sherpa_onnx
