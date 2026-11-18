#pragma once

#include "ReaderDocument.h"

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace reader {

/** One sentence of a block: [start, end) in UTF-16 units of the block text. */
struct SentenceRange {
  int start = 0;
  int end = 0;
};

/**
 * Splits text into sentences. Boundaries are the characters of the default
 * text segmentation (src/segment, `seg_is_default_sentence_boundary` in
 * SegEngine.cpp): `. ! ? ; :`, a line break, and 。！？｡ ؟ । ॥. Rules on top:
 *
 * - ASCII marks end a sentence only before whitespace or the end of the text
 *   (`3.14`, `e.g.x`, `10:30` stay whole); the other marks always end one.
 * - A run of marks (`?!`, `...`) and the closing quotes / brackets after it
 *   stay with the sentence.
 * - Sentences are trimmed of surrounding whitespace; whitespace-only pieces
 *   are dropped. A line break always ends a sentence.
 *
 * Ranges are sorted and do not overlap. Gaps between them are whitespace.
 */
std::vector<SentenceRange> SplitSentences(const std::string& utf8);

/** Sentences of a block (empty for image, page and separator blocks). */
std::vector<SentenceRange> BlockSentences(const ReaderSnapshot& snap, int block);

/** How a selection is widened (`selectionSnap`). */
enum class SelectionSnap : int { None = 0, Sentence = 1, Block = 2 };

SelectionSnap SelectionSnapFromName(const char* name);

/**
 * Widens [start, end) of a block's text: `Sentence` to the sentences it
 * touches (from the start of the sentence holding `start` to the end of the
 * one holding `end - 1`; a start in a gap moves to the next sentence, an end
 * in a gap back to the previous one), `Block` to the whole block, `None`
 * keeps the range. Offsets are clamped to the block length first.
 */
SentenceRange SnapRange(const ReaderSnapshot& snap, int block, int start, int end,
                        SelectionSnap mode);

/** The sentences [start, end) touches, as one range (`SnapRange` with `Sentence`). */
SentenceRange EnclosingSentences(const ReaderSnapshot& snap, int block, int start, int end);

}  // namespace reader
}  // namespace sherpa_onnx
