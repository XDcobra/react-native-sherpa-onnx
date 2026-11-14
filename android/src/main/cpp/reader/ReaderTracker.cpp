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

std::vector<TrackerEvent> ReaderTracker::Sample(int first, int last, ScrollPhase phase) {
  std::vector<TrackerEvent> out;
  if (first < 0 || last < first) return out;

  const bool changed = !hasPrev_ || first != prevFirst_ || last != prevLast_;
  if (changed || phase == ScrollPhase::Idle) {
    TrackerEvent v;
    v.kind = TrackerEvent::Kind::VisibleRange;
    v.first = first;
    v.last = last;
    v.settled = phase == ScrollPhase::Idle;
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

  switch (phase) {
    case ScrollPhase::Programmatic:
      inFling_ = false;
      if (first != prevFirst_) jump(prevFirst_, first, "scrollTo");
      StartSegment(first, last);
      if (first <= frontier_ + 1) Extend(first, last, &out);
      break;

    case ScrollPhase::Momentum:
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
