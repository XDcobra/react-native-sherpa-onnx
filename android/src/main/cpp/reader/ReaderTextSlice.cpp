#include "ReaderTextSlice.h"

#include "../textbuffer/TxtUtf16.h"

#include <algorithm>

namespace sherpa_onnx {
namespace reader {

namespace {

bool Readable(const ReaderSnapshot& snap, int i) {
  const ReaderBlock& b = snap.blocks[i];
  return (b.type == ReaderBlockType::Paragraph || b.type == ReaderBlockType::Heading) &&
         !(b.flags & kBlockFurniture) && snap.BlockLength(i) > 0;
}

/** Byte offset of a UTF-16 offset in UTF-8 text. */
size_t ByteAt(const std::string& s, int units) {
  size_t byte = 0;
  int u = 0;
  while (byte < s.size() && u < units) {
    const unsigned char c = static_cast<unsigned char>(s[byte]);
    if (c >= 0xF0) {
      byte += 4;
      u += 2;
    } else if (c >= 0xE0) {
      byte += 3;
      u += 1;
    } else if (c >= 0xC0) {
      byte += 2;
      u += 1;
    } else {
      byte += 1;
      u += 1;
    }
  }
  return std::min(byte, s.size());
}

}  // namespace

bool BuildTextSlice(const ReaderSnapshot& snap, int fromBlock, int fromOffset, int toBlock,
                    int maxLength, ReaderTextSlice* out) {
  if (!out || fromBlock < 0 || fromBlock >= static_cast<int>(snap.blocks.size())) return false;
  *out = ReaderTextSlice();
  out->documentId = snap.documentId;
  const int n = static_cast<int>(snap.blocks.size());
  const int last = toBlock >= 0 ? std::min(toBlock, n - 1) : n - 1;
  for (int i = fromBlock; i <= last; ++i) {
    if (!Readable(snap, i)) continue;
    std::string text = snap.BlockText(i);
    int offset = 0;
    if (i == fromBlock && fromOffset > 0) {
      offset = std::min(fromOffset, snap.BlockLength(i));
      text.erase(0, ByteAt(text, offset));
      if (text.empty()) continue;
    }
    const int len = txt_utf16_length(text);
    const int sep = out->entries.empty() ? 0 : 2;
    if (maxLength > 0 && !out->entries.empty() && out->length + sep + len > maxLength) break;
    if (sep) {
      out->text += "\n\n";
      out->length += 2;
    }
    out->entries.push_back({snap.blocks[i].id, out->length, len, offset});
    out->text += text;
    out->length += len;
  }
  return !out->entries.empty();
}

bool MapSliceRange(const ReaderTextSlice& slice, const ReaderSnapshot& snap, int start, int end,
                   int* fromBlock, int* fromOffset, int* toBlock, int* toOffset) {
  if (end <= start) return false;
  const ReaderSliceEntry* a = nullptr;
  const ReaderSliceEntry* z = nullptr;
  int ai = -1;
  int zi = -1;
  for (const ReaderSliceEntry& e : slice.entries) {
    const int idx = snap.BlockIndex(e.blockId);
    if (idx < 0 || e.sliceStart + e.length <= start) continue;
    if (e.sliceStart >= end) break;
    if (!a) {
      a = &e;
      ai = idx;
    }
    z = &e;
    zi = idx;
  }
  if (!a) return false;
  *fromBlock = ai;
  *fromOffset = a->blockOffset + std::max(0, start - a->sliceStart);
  *toBlock = zi;
  *toOffset = z->blockOffset + std::min(end, z->sliceStart + z->length) - z->sliceStart;
  return true;
}

}  // namespace reader
}  // namespace sherpa_onnx
