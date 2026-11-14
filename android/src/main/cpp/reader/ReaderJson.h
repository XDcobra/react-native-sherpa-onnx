#pragma once

#include "ReaderDocument.h"

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

/** `[{"from":locator,"to":locator} | null, ...]` for text-buffer UTF-16 ranges (see MapTextRange). */
std::string TextRangesJson(const ReaderSnapshot& snap, const std::vector<int>& starts,
                           const std::vector<int>& ends);

}  // namespace reader
}  // namespace sherpa_onnx
