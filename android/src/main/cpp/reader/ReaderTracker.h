#pragma once

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace reader {

/** Where a visibility sample comes from (platform scroll callbacks map to these). */
enum class ScrollPhase : int {
  Drag = 0,  // finger on screen
  Momentum = 1,  // fling after the finger lifted
  Idle = 2,  // scrolling stopped
  Programmatic = 3,  // scrollTo / initial locator
  Layout = 4,  // size / theme / data change without user scrolling
};

struct TrackerEvent {
  enum class Kind { VisibleRange, Furthest, SectionEnd, Jump };
  Kind kind = Kind::VisibleRange;
  int first = -1;  // VisibleRange
  int last = -1;
  bool settled = false;
  int block = -1;  // Furthest / SectionEnd: flat block index
  int section = -1;  // SectionEnd: section position
  int from = -1;  // Jump
  int to = -1;
  int distance = 0;
  std::string cause;  // "scroll" | "fling" | "scrollTo"
};

/**
 * Reading-progress rules shared by the iOS and Android ReaderView
 * (docs/reader.md, "Events"). Indices are flat block indices (inserts excluded).
 *
 * - Visible range: emitted when first/last change (`settled` for idle and
 *   layout samples), and on every idle sample.
 * - Jump: a move of more than N blocks without continuous visibility —
 *   while dragging ("scroll"), a fling that lands further than N blocks from
 *   where the finger lifted ("fling"), or any programmatic scroll ("scrollTo").
 * - Furthest position: the end of the continuously read stretch, advanced only
 *   while that stretch starts at or before the current frontier + 1.
 * - Section end: the last block of a section becomes visible while reading
 *   continuously (once per transition).
 */
class ReaderTracker {
 public:
  /** @param sectionLastBlocks flat index of the last block of each section (ascending). */
  explicit ReaderTracker(std::vector<int> sectionLastBlocks = {}, int jumpThreshold = 20);

  void SetSections(std::vector<int> sectionLastBlocks);
  void SetJumpThreshold(int blocks);
  /** Frontier from the app (`furthestLocator`), -1 for none. Emits nothing. */
  void SetFrontier(int blockIndex);
  int Frontier() const { return frontier_; }

  std::vector<TrackerEvent> Sample(int first, int last, ScrollPhase phase);

 private:
  void Extend(int first, int last, std::vector<TrackerEvent>* out);
  void StartSegment(int first, int last);
  void EmitSectionEnds(int first, int last, std::vector<TrackerEvent>* out);

  std::vector<int> sectionLast_;
  int threshold_;
  int frontier_ = -1;
  bool frontierFromApp_ = false;
  bool hasPrev_ = false;
  int prevFirst_ = -1;
  int prevLast_ = -1;
  int segStart_ = -1;
  int segEnd_ = -1;
  bool inFling_ = false;
  int flingFromFirst_ = -1;
  int flingFromLast_ = -1;
  // Range of the previous continuous sample, for section-end transitions.
  int seenFirst_ = -1;
  int seenLast_ = -1;
};

}  // namespace reader
}  // namespace sherpa_onnx
