#include "decode/ThinningPlanner.h"

#include "VideoLog.h"

namespace sherpa_onnx {
namespace video {
namespace {

int64_t RefPacketsBetween(const Timeline& tl, int64_t fromDecInclusive,
                          int64_t toDecInclusive) {
  if (toDecInclusive < fromDecInclusive) {
    return 0;
  }
  int64_t n = 0;
  for (int64_t d = fromDecInclusive; d <= toDecInclusive; ++d) {
    const int64_t p = tl.PresentationOfDecode(d);
    SampleEntry s;
    if (!tl.Get(p, &s).ok) {
      continue;
    }
    if ((s.flags & kSampleNonRef) == 0) {
      ++n;
    }
  }
  return n;
}

}  // namespace

ThinningPlan ThinningPlanner::Plan(const Timeline& timeline,
                                   const std::vector<int64_t>& selectedPres) {
  ThinningPlan plan;
  if (selectedPres.empty() || timeline.frameCount() <= 0) {
    return plan;
  }
  int64_t cursorDec = -1;
  for (int64_t pres : selectedPres) {
    if (pres < 0 || pres >= timeline.frameCount()) {
      continue;
    }
    const int64_t targetDec = timeline.DecodeIndexOf(pres);
    const int64_t keyPres = timeline.KeyframeAtOrBefore(pres);
    const int64_t keyDec = timeline.DecodeIndexOf(keyPres);
    const int64_t throughFrom = cursorDec < 0 ? keyDec : cursorDec + 1;
    int64_t throughCost = 0;
    bool canThrough = cursorDec >= 0 && targetDec >= throughFrom &&
                      keyDec <= cursorDec;
    if (canThrough) {
      throughCost = RefPacketsBetween(timeline, throughFrom, targetDec);
    } else {
      throughCost = RefPacketsBetween(timeline, keyDec, targetDec) + 1000000;
    }
    const int64_t jumpCost = RefPacketsBetween(timeline, keyDec, targetDec);
    const bool jump = !canThrough || jumpCost < throughCost;
    const int64_t startDec = jump ? keyDec : throughFrom;
    if (jump) {
      plan.seekDecodeIndices.push_back(keyDec);
    }
    for (int64_t d = startDec; d <= targetDec; ++d) {
      const int64_t p = timeline.PresentationOfDecode(d);
      SampleEntry s;
      if (!timeline.Get(p, &s).ok) {
        continue;
      }
      const bool selected = p == pres;
      if ((s.flags & kSampleNonRef) != 0 && !selected) {
        continue;
      }
      plan.submitDecodeIndices.push_back(d);
    }
    cursorDec = targetDec;
  }
  VIDEO_LOGD("video.decode thinning submits=%zu seeks=%zu",
             plan.submitDecodeIndices.size(), plan.seekDecodeIndices.size());
  return plan;
}

}  // namespace video
}  // namespace sherpa_onnx
