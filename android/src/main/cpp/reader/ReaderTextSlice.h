#pragma once

#include "ReaderDocument.h"

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace reader {

/** One block's text in a slice: [sliceStart, sliceStart + length) is block text from blockOffset on. */
struct ReaderSliceEntry {
  std::string blockId;
  int sliceStart = 0;  // UTF-16 in the slice text
  int length = 0;  // UTF-16
  int blockOffset = 0;  // UTF-16 offset in the block where the slice part starts
};

/**
 * Text of consecutive blocks for reading aloud: paragraphs and headings in
 * reading order (file, OCR and app blocks; running headers, footers and page
 * numbers left out), joined by a blank line. Block IDs, not flat indices, so
 * it stays valid across revisions.
 */
struct ReaderTextSlice {
  std::string documentId;
  std::string text;  // UTF-8
  int length = 0;  // UTF-16
  std::vector<ReaderSliceEntry> entries;
};

/**
 * Builds a slice starting at `fromBlock` / `fromOffset` (UTF-16 in that
 * block; a non-text block starts at the next text block). It ends after
 * `toBlock` (inclusive; -1 = no end) or before the first block that would make
 * it longer than `maxLength` UTF-16 units (<= 0 = no limit; the first block is
 * always included). False when no text block follows `fromBlock`.
 */
bool BuildTextSlice(const ReaderSnapshot& snap, int fromBlock, int fromOffset, int toBlock,
                    int maxLength, ReaderTextSlice* out);

/**
 * Maps a UTF-16 range of a slice onto blocks of `snap` (by block ID; blocks
 * gone in this revision are skipped). A start in a gap moves to the next
 * entry, an end to the previous one. False when the range touches no entry.
 */
bool MapSliceRange(const ReaderTextSlice& slice, const ReaderSnapshot& snap, int start, int end,
                   int* fromBlock, int* fromOffset, int* toBlock, int* toOffset);

}  // namespace reader
}  // namespace sherpa_onnx
