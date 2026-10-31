#pragma once

#include <cstdint>
#include <vector>

#include "core/Timeline.h"

namespace sherpa_onnx {
namespace video {

struct ThinningPlan {
  /** Decode-order packet indices to submit (already filtered). */
  std::vector<int64_t> submitDecodeIndices;
  /** Decode-order index of each seek/flush (first packet of a jump). */
  std::vector<int64_t> seekDecodeIndices;
};

class ThinningPlanner {
 public:
  /**
   * selectedPres = presentation indices to emit.
   * Non-reference packets that are not selected are never submitted.
   * For each next target: cheaper of decode-through vs jump-to-keyframe
   * (ties → decode-through).
   */
  static ThinningPlan Plan(const Timeline& timeline,
                           const std::vector<int64_t>& selectedPres);
};

}  // namespace video
}  // namespace sherpa_onnx
