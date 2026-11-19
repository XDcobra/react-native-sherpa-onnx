#include "ReaderTracker.h"

#include <algorithm>
#include <cstdlib>
#include <utility>

namespace sherpa_onnx {
namespace reader {

ReaderTracker::ReaderTracker(std::vector<int> sectionLastBlocks, int jumpThreshold)
    : sectionLast_(std::move(sectionLastBlocks)), threshold_(std::max(1, jumpThreshold)) {}

void ReaderTracker::SetSections(std::vector<int> sectionLastBlocks) {
  sectionLast_ = std::move(sectionLastBlocks);
}

void ReaderTracker::SetJumpThreshold(int blocks) { threshold_ = std::max(1, blocks); }

void ReaderTracker::SetFrontier(int blockIndex) {
  frontier_ = blockIndex;
  frontierFromApp_ = blockIndex >= 0;
}

void ReaderTracker::StartSegment(int first, int last) {
  segStart_ = first;
  segEnd_ = last;
  seenFirst_ = first;
  seenLast_ = last;
}

void ReaderTracker::EmitSectionEnds(int first, int last, std::vector<TrackerEvent>* out) {
  for (int s = 0; s < static_cast<int>(sectionLast_.size()); ++s) {
    const int b = sectionLast_[s];
    if (b < first || b > last) continue;
    const bool wasVisible = seenFirst_ >= 0 && b >= seenFirst_ && b <= seenLast_;
    if (wasVisible) continue;
    TrackerEvent e;
    e.kind = TrackerEvent::Kind::SectionEnd;
    e.block = b;
    e.section = s;
    out->push_back(e);
  }
}

void ReaderTracker::Extend(int first, int last, std::vector<TrackerEvent>* out) {
  EmitSectionEnds(first, last, out);
  seenFirst_ = first;
  seenLast_ = last;
  segStart_ = std::min(segStart_, first);
  segEnd_ = std::max(segEnd_, last);
  if (frontier_ < 0) {
    frontier_ = segEnd_;
    TrackerEvent e;
    e.kind = TrackerEvent::Kind::Furthest;
    e.block = frontier_;
    out->push_back(e);
    return;
  }
  if (segStart_ <= frontier_ + 1 && segEnd_ > frontier_) {
    frontier_ = segEnd_;
    TrackerEvent e;
    e.kind = TrackerEvent::Kind::Furthest;
    e.block = frontier_;
    out->push_back(e);
  }
}

std::vector<TrackerEvent> ReaderTracker::Sample(int first, int last, ScrollPhase phase,
                                                int shownFirst, int shownLast) {
  std::vector<TrackerEvent> out;
  const bool hasShown = shownFirst >= 0 && shownLast >= shownFirst;
  if (first < 0 || last < first) {
    if (!hasShown) return out;
    first = shownFirst;
    last = shownLast;
  }
  if (!hasShown) {
    shownFirst = first;
    shownLast = last;
  }

  const bool changed = !hasPrev_ || shownFirst != prevShownFirst_ || shownLast != prevShownLast_;
  prevShownFirst_ = shownFirst;
  prevShownLast_ = shownLast;
  if (changed || phase == ScrollPhase::Idle) {
    TrackerEvent v;
    v.kind = TrackerEvent::Kind::VisibleRange;
    v.first = shownFirst;
    v.last = shownLast;
    // Layout changes (reflow, theme, data) happen at rest, so they are settled too.
    v.settled = phase == ScrollPhase::Idle || phase == ScrollPhase::Layout;
    out.push_back(v);
  }

  auto jump = [&](int from, int to, const char* cause) {
    TrackerEvent j;
    j.kind = TrackerEvent::Kind::Jump;
    j.from = from;
    j.to = to;
    j.distance = to - from;
    j.cause = cause;
    out.push_back(j);
  };

  if (!hasPrev_) {
    // First layout: the initial viewport counts as read unless the app set a
    // frontier that this viewport does not continue.
    hasPrev_ = true;
    prevFirst_ = first;
    prevLast_ = last;
    StartSegment(first, last);
    if (!frontierFromApp_ || first <= frontier_ + 1) {
      segStart_ = first;
      Extend(first, last, &out);
    }
    return out;
  }

  // An indicator drag ends with the first sample that is not part of it: one
  // jump from where it started to where it landed (at rest: this sample).
  if (inScrub_ && phase != ScrollPhase::Scrub && phase != ScrollPhase::Momentum &&
      phase != ScrollPhase::Layout) {
    inScrub_ = false;
    const bool atRest = phase == ScrollPhase::Idle;
    const int toFirst = atRest ? first : prevFirst_;
    const int toLast = atRest ? last : prevLast_;
    if (toFirst != scrubFrom_) jump(scrubFrom_, toFirst, "drag");
    StartSegment(toFirst, toLast);
    if (toFirst <= frontier_ + 1) Extend(toFirst, toLast, &out);
    if (atRest) {
      prevFirst_ = first;
      prevLast_ = last;
      return out;
    }
  }

  switch (phase) {
    case ScrollPhase::Scrub:
      if (!inScrub_) {
        inScrub_ = true;
        inFling_ = false;
        scrubFrom_ = prevFirst_;
      }
      break;

    case ScrollPhase::Programmatic:
      inFling_ = false;
      if (first != prevFirst_) jump(prevFirst_, first, "scrollTo");
      StartSegment(first, last);
      if (first <= frontier_ + 1) Extend(first, last, &out);
      break;

    case ScrollPhase::Momentum:
      if (inScrub_) break;  // the indicator glides out: still the same drag
      if (!inFling_) {
        inFling_ = true;
        flingFromFirst_ = prevFirst_;
        flingFromLast_ = prevLast_;
      }
      break;

    case ScrollPhase::Idle:
      if (inFling_) {
        inFling_ = false;
        const bool far = first > flingFromLast_ + threshold_ || last < flingFromFirst_ - threshold_;
        if (far) {
          jump(flingFromFirst_, first, "fling");
          StartSegment(first, last);
          break;
        }
        Extend(std::min(first, flingFromFirst_), std::max(last, flingFromLast_), &out);
        seenFirst_ = first;
        seenLast_ = last;
        break;
      }
      [[fallthrough]];
    case ScrollPhase::Drag: {
      const bool far = first > prevLast_ + threshold_ || last < prevFirst_ - threshold_;
      if (far) {
        jump(prevFirst_, first, "scroll");
        StartSegment(first, last);
      } else {
        Extend(first, last, &out);
      }
      break;
    }

    case ScrollPhase::Follow: {
      // Auto-scroll along a highlight: continuous reading unless it moves far
      // (e.g. read-aloud restarted elsewhere), which is a jump like scrollTo.
      inFling_ = false;
      const bool far = first > prevLast_ + threshold_ || last < prevFirst_ - threshold_;
      if (far) {
        jump(prevFirst_, first, "follow");
        StartSegment(first, last);
        if (first <= frontier_ + 1) Extend(first, last, &out);
      } else {
        Extend(first, last, &out);
      }
      break;
    }

    case ScrollPhase::Layout:
      seenFirst_ = first;
      seenLast_ = last;
      break;
  }

  prevFirst_ = first;
  prevLast_ = last;
  return out;
}

}  // namespace reader
}  // namespace sherpa_onnx
