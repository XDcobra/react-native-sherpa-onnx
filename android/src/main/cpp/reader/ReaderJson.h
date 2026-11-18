#pragma once

#include "ReaderDocument.h"
#include "ReaderTextSlice.h"

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace reader {

/**
 * JSON views of a snapshot for JS (parsed by src/reader). Shared by both
 * bridges so iOS and Android return identical shapes.
 */
std::string SnapshotSummaryJson(const ReaderSnapshot& snap);

/** Blocks [start, start + max) with id, section, type, level, textHash, image info and optional text. */
std::string BlocksJson(const ReaderSnapshot& snap, int start, int max, bool includeText);

std::string JsonEscape(const std::string& s);

/**
 * Contents as `[{title, level, sectionId, blockId}]`: the source's contents,
 * else every titled section (level 1). Entries whose block is gone are skipped.
 */
std::string TocJson(const ReaderSnapshot& snap);

/**
 * Pages that can get OCR text: `{"imageBufferId", "pages":[{sectionId, blockId,
 * frame, hasText}]}` for every page block and every image block of an
 * image-only section, in reading order. `hasText`: the page already has text
 * blocks (text layer or OCR).
 */
std::string PagesJson(const ReaderSnapshot& snap);

/** `[{"from":locator,"to":locator} | null, ...]` for text-buffer UTF-16 ranges (see MapTextRange). */
std::string TextRangesJson(const ReaderSnapshot& snap, const std::vector<int>& starts,
                           const std::vector<int>& ends);

/** The same for UTF-16 ranges of a text slice (see MapSliceRange). */
std::string SliceRangesJson(const ReaderSnapshot& snap, const ReaderTextSlice& slice,
                            const std::vector<int>& starts, const std::vector<int>& ends);

/** `{bufferId, length, from: locator, to: locator}` of a new slice. */
std::string SliceJson(const ReaderSnapshot& snap, const ReaderTextSlice& slice,
                      const std::string& bufferId);

/**
 * `[{blockId, index, start, end}]`: the sentences of each block in `blockIds`
 * (see SplitSentences; UTF-16 offsets in the block, `index` from 0 per
 * block). Blocks without text add nothing. False with `*unknownId` set when a
 * block ID is unknown.
 */
bool SentencesJson(const ReaderSnapshot& snap, const std::vector<std::string>& blockIds,
                   std::string* json, std::string* unknownId);

}  // namespace reader
}  // namespace sherpa_onnx
