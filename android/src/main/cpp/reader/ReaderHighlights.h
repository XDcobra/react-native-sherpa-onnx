#pragma once

#include "ReaderDocument.h"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace sherpa_onnx {
namespace reader {

enum class HighlightStyle : int { Background = 0, Underline = 1, TextColor = 2 };

/** One `highlights` entry from the view props (block IDs, UTF-16 offsets in the block). */
struct HighlightInput {
  std::string id;
  std::string fromBlockId;
  int fromOffset = -1;  // < 0: start of the block
  std::string toBlockId;
  int toOffset = -1;  // exclusive; < 0: end of the block
  HighlightStyle style = HighlightStyle::Background;
  uint32_t color = 0;  // ARGB
  bool hasColor = false;  // false: the view's default (accent)
  bool follow = false;
};

/** Part of a highlight inside one block, [start, end) in UTF-16 units of the block text. */
struct HighlightSpan {
  int start = 0;
  int end = 0;
  HighlightStyle style = HighlightStyle::Background;
  uint32_t color = 0;
  bool hasColor = false;
};

struct ResolvedHighlights {
  /** Spans per flat block index, in input order (later entries draw on top). */
  std::unordered_map<int, std::vector<HighlightSpan>> byBlock;
  /** Start of the first highlight with `follow`; -1 when none. */
  int followBlock = -1;
  int followOffset = 0;
  /** End of that highlight (block, exclusive offset). */
  int followEndBlock = -1;
  int followEndOffset = 0;
  /** IDs whose block IDs are unknown or whose range is reversed (ignored). */
  std::vector<std::string> invalidIds;
};

/**
 * Resolves highlight inputs against a snapshot. Ranges may span blocks; blocks
 * in between are covered whole. Image and separator blocks get no spans.
 * Offsets are clamped to the block length and moved off the middle of a
 * surrogate pair.
 */
ResolvedHighlights ResolveHighlights(const ReaderSnapshot& snap,
                                     const std::vector<HighlightInput>& inputs);

}  // namespace reader
}  // namespace sherpa_onnx
