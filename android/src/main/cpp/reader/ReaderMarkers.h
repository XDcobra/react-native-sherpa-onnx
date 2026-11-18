#pragma once

#include "ReaderDocument.h"
#include "ReaderHighlights.h"

#include <string>
#include <unordered_map>
#include <vector>

namespace sherpa_onnx {
namespace reader {

/** One `markers` entry from the view props (UTF-16 offsets in the block). */
struct MarkerInput {
  std::string id;
  std::string blockId;
  int start = -1;  // < 0 with end < 0: the marker belongs to the whole block
  int end = -1;    // exclusive
};

/** Where a marker sits in its block. */
struct MarkerAnchor {
  /** Index into the inputs (labels and colors stay with the platform). */
  int input = 0;
  /**
   * UTF-16 offset whose line the marker is drawn at: the last character of
   * the range; -1 for a block marker (drawn at the block's first line) and
   * for markers on image, page and separator blocks.
   */
  int offset = -1;
};

struct ResolvedMarkers {
  /** Anchors per flat block index, in input order. */
  std::unordered_map<int, std::vector<MarkerAnchor>> byBlock;
  /** IDs whose block ID is unknown or whose range is reversed (ignored). */
  std::vector<std::string> invalidIds;
};

/**
 * Resolves margin markers against a snapshot. A range is clamped to the block
 * length and anchored at its last character (`start` alone: that character);
 * offsets never point into the middle of a surrogate pair.
 */
ResolvedMarkers ResolveMarkers(const ReaderSnapshot& snap, const std::vector<MarkerInput>& inputs);

/**
 * Line of a marker on a page image (normalized to the page): the line box of
 * `offset`, else the block's first line box, else its rectangle, else the
 * page's top edge.
 */
PageRect MarkerPageRect(const ReaderSnapshot& snap, int block, int offset);

}  // namespace reader
}  // namespace sherpa_onnx
