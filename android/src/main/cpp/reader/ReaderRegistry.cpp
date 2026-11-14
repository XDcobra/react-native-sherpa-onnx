#include "ReaderRegistry.h"

#include "ReaderTextHash.h"
#include "../textbuffer/TxtUtf16.h"

#include <algorithm>
#include <cstdlib>
#include <unordered_set>

namespace sherpa_onnx {
namespace reader {

const char* ReaderBlockTypeName(ReaderBlockType t) {
  switch (t) {
    case ReaderBlockType::Heading: return "heading";
    case ReaderBlockType::Image: return "image";
    case ReaderBlockType::Separator: return "separator";
    case ReaderBlockType::Page: return "page";
    default: return "paragraph";
  }
}

int SupportedStructureVersion(const std::string& format) {
  if (format == "epub") return kStructureVersion;
  if (format == "fb2" || format == "mobi" || format == "pdf" || format == "pages") return 1;
  return 0;
}

std::string ReaderSnapshot::BlockText(int index) const {
  if (index < 0 || index >= static_cast<int>(blocks.size())) return {};
  const ReaderBlock& b = blocks[index];
  if (!b.textSource || b.textByteEnd <= b.textByteStart) return {};
  return b.textSource->substr(static_cast<size_t>(b.textByteStart),
                              static_cast<size_t>(b.textByteEnd - b.textByteStart));
}

int ReaderSnapshot::BlockLength(int index) const {
  if (index < 0 || index >= static_cast<int>(blocks.size())) return 0;
  return blocks[index].textUtf16Len;
}

void SetOwnBlockText(ReaderBlock* b, std::string text) {
  b->textUtf16Len = txt_utf16_length(text);
  b->textByteStart = 0;
  b->textByteEnd = static_cast<int>(text.size());
  b->textSource = std::make_shared<const std::string>(std::move(text));
}

void ResolveByteRanges(const std::shared_ptr<const std::string>& source,
                       std::vector<ReaderBlock*>* blocks) {
  // Blocks are in buffer order; one forward pass maps UTF-16 → byte offsets.
  std::vector<ReaderBlock*>& bs = *blocks;
  std::stable_sort(bs.begin(), bs.end(), [](const ReaderBlock* x, const ReaderBlock* y) {
    return x->utf16Start < y->utf16Start;
  });
  const std::string& s = *source;
  size_t byte = 0;
  int u16 = 0;
  auto advance_to = [&](int target) {
    while (u16 < target && byte < s.size()) {
      const unsigned char c = static_cast<unsigned char>(s[byte]);
      int len = 1;
      int units = 1;
      if (c >= 0xF0) {
        len = 4;
        units = 2;
      } else if (c >= 0xE0) {
        len = 3;
      } else if (c >= 0xC0) {
        len = 2;
      }
      byte = std::min(s.size(), byte + static_cast<size_t>(len));
      u16 += units;
    }
    return static_cast<int>(byte);
  };
  // Starts and ends interleave in buffer order (blocks do not overlap).
  for (ReaderBlock* b : bs) {
    b->textSource = source;
    b->textByteStart = advance_to(b->utf16Start);
    b->textByteEnd = advance_to(b->utf16End);
    b->textUtf16Len = std::max(0, b->utf16End - b->utf16Start);
  }
}

bool ReaderSnapshot::MapTextRange(int start, int end, int* fromBlock, int* fromOffset,
                                  int* toBlock, int* toOffset) const {
  if (textBlocks.empty() || end <= start) return false;
  // First block that ends after `start`.
  auto lo = std::partition_point(textBlocks.begin(), textBlocks.end(),
                                 [&](int i) { return blocks[i].utf16End <= start; });
  // Last block that starts before `end`.
  auto hi = std::partition_point(textBlocks.begin(), textBlocks.end(),
                                 [&](int i) { return blocks[i].utf16Start < end; });
  if (lo == textBlocks.end() || hi == textBlocks.begin()) return false;
  --hi;
  if (hi < lo) return false;  // the range lies entirely in a gap
  const ReaderBlock& a = blocks[*lo];
  const ReaderBlock& z = blocks[*hi];
  *fromBlock = *lo;
  *fromOffset = std::max(0, start - a.utf16Start);
  *toBlock = *hi;
  *toOffset = std::min(end, z.utf16End) - z.utf16Start;
  return true;
}

int ReaderSnapshot::BlockIndex(const std::string& blockId) const {
  auto it = blockIndexById.find(blockId);
  return it == blockIndexById.end() ? -1 : it->second;
}

int ReaderSnapshot::SectionIndex(const std::string& sectionId) const {
  auto it = sectionIndexById.find(sectionId);
  return it == sectionIndexById.end() ? -1 : it->second;
}

void ReindexSnapshot(ReaderSnapshot* snap) {
  snap->blockIndexById.clear();
  snap->sectionIndexById.clear();
  snap->blockIndexById.reserve(snap->blocks.size());
  int cursor = 0;
  for (int s = 0; s < static_cast<int>(snap->sections.size()); ++s) {
    ReaderSection& sec = snap->sections[s];
    sec.firstBlock = cursor;
    for (int k = 0; k < sec.blockCount; ++k) snap->blocks[cursor + k].section = s;
    cursor += sec.blockCount;
    snap->sectionIndexById[sec.id] = s;
  }
  snap->textBlocks.clear();
  for (int i = 0; i < static_cast<int>(snap->blocks.size()); ++i) {
    const ReaderBlock& b = snap->blocks[i];
    snap->blockIndexById[b.id] = i;
    if (b.fromFile && b.utf16End > b.utf16Start) snap->textBlocks.push_back(i);
  }
  // Buffer order equals reading order for file blocks; sort defensively.
  std::stable_sort(snap->textBlocks.begin(), snap->textBlocks.end(), [&](int x, int y) {
    return snap->blocks[x].utf16Start < snap->blocks[y].utf16Start;
  });
}

std::shared_ptr<const ReaderSnapshot> MakePlaceholderSnapshot(int rows) {
  auto snap = std::make_shared<ReaderSnapshot>();
  snap->documentId = "debug";
  constexpr int kPerSection = 10;
  for (int s = 0; s * kPerSection < rows; ++s) {
    ReaderSection sec;
    sec.id = "s" + std::to_string(s);
    sec.sectionIndex = s;
    sec.kind = "text";
    sec.titleSource = "none";
    sec.blockCount = std::min(kPerSection, rows - s * kPerSection);
    for (int b = 0; b < sec.blockCount; ++b) {
      ReaderBlock blk;
      blk.id = sec.id + ".b" + std::to_string(b);
      blk.fromFile = false;
      std::string text = blk.id + " - ";
      for (int k = 0; k <= (s * kPerSection + b) % 4; ++k) {
        text += "The quick brown fox jumps over the lazy dog. ";
      }
      blk.textHash = TextHashV1(text);
      SetOwnBlockText(&blk, std::move(text));
      snap->blocks.push_back(std::move(blk));
    }
    snap->sections.push_back(std::move(sec));
  }
  ReindexSnapshot(snap.get());
  return snap;
}

int RemapBlockByHash(const ReaderSnapshot& snap, const std::string& textHash, int hintIndex) {
  int best = -1;
  int bestDist = 0;
  for (int i = 0; i < static_cast<int>(snap.blocks.size()); ++i) {
    if (snap.blocks[i].textHash != textHash) continue;
    const int dist = std::abs(i - hintIndex);
    if (best < 0 || dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

namespace {

void SetErr(ReaderError* err, const char* code, const std::string& message) {
  if (err) {
    err->code = code;
    err->message = message;
  }
}

bool ValidKeyChars(const std::string& s) {
  if (s.empty()) return false;
  for (char c : s) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                    c == '_' || c == '-';
    if (!ok) return false;
  }
  return true;
}

}  // namespace

ReaderRegistry& ReaderRegistry::Instance() {
  static ReaderRegistry r;
  return r;
}

std::string ReaderRegistry::Create(std::shared_ptr<TxtOfflineEntry> text,
                                   const std::string& imageBufferId,
                                   const std::vector<std::string>& frameHrefs,
                                   const std::string& documentKey, ReaderError* err) {
  if (!text) {
    SetErr(err, kErrReaderNotFound, "Text buffer not found");
    return {};
  }
  std::shared_ptr<const TxtStructure> st = text->getStructure();
  if (!st) {
    SetErr(err, kErrReaderNoStructure,
           "Text buffer has no reading structure (extract an EPUB with extractDocumentText)");
    return {};
  }
  const std::string format = st->format.empty() ? "epub" : st->format;
  const int supported = SupportedStructureVersion(format);
  if (supported == 0 || st->version != supported) {
    SetErr(err, kErrReaderUnsupportedStructure,
           "Unsupported structure: " + format + " v" + std::to_string(st->version));
    return {};
  }
  std::unordered_map<std::string, int> frameByHref;
  for (int i = 0; i < static_cast<int>(frameHrefs.size()); ++i) {
    frameByHref.emplace(frameHrefs[i], i);  // first frame per href
  }

  auto snap = std::make_shared<ReaderSnapshot>();
  snap->documentKey = documentKey;
  snap->format = format;
  snap->structureVersion = st->version;
  snap->imageBufferId = imageBufferId;
  snap->text = text;
  snap->title = st->title;
  snap->creator = st->creator;
  snap->language = st->language;
  snap->sections.reserve(st->sections.size());
  snap->blocks.reserve(st->blocks.size());
  for (const TxtStructSection& ss : st->sections) {
    ReaderSection sec;
    sec.id = "s" + std::to_string(ss.sectionIndex);
    sec.sectionIndex = ss.sectionIndex;
    sec.kind = ss.kind;
    sec.href = ss.href;
    sec.title = ss.title;
    sec.titleSource = ss.titleSource.empty() ? "none" : ss.titleSource;
    sec.blockCount = ss.blockCount;
    for (int k = 0; k < ss.blockCount; ++k) {
      const TxtStructBlock& sb = st->blocks[ss.firstBlock + k];
      ReaderBlock b;
      b.id = sec.id + ".b" + std::to_string(sb.blockIndex);
      b.type = static_cast<ReaderBlockType>(sb.type);
      b.headingLevel = sb.headingLevel;
      b.utf16Start = sb.utf16Start;
      b.utf16End = sb.utf16End;
      b.imageHref = sb.imageHref;
      b.alt = sb.alt;
      b.hasAlt = sb.hasAlt;
      b.flags = sb.flags;
      b.hasRect = sb.hasRect;
      for (int r = 0; r < 4; ++r) b.rect[r] = sb.rect[r];
      if (b.type == ReaderBlockType::Image || b.type == ReaderBlockType::Page) {
        if (sb.frameIndex >= 0) {
          b.imageFrame = sb.frameIndex;
        } else if (!b.imageHref.empty()) {
          auto f = frameByHref.find(b.imageHref);
          if (f != frameByHref.end()) b.imageFrame = f->second;
        }
        b.textHash = ImageHashV1(b.imageHref);
      } else if (b.type == ReaderBlockType::Separator) {
        b.textHash = SeparatorHashV1();
      }
      snap->blocks.push_back(std::move(b));
    }
    snap->sections.push_back(std::move(sec));
  }
  // Text: alias the buffer (UTF-8 byte ranges resolved in one pass), then hash.
  std::shared_ptr<const std::string> source(text, &text->text);
  std::vector<ReaderBlock*> textual;
  for (ReaderBlock& b : snap->blocks) {
    if (b.type == ReaderBlockType::Paragraph || b.type == ReaderBlockType::Heading) {
      textual.push_back(&b);
    }
  }
  ResolveByteRanges(source, &textual);
  for (int i = 0; i < static_cast<int>(snap->blocks.size()); ++i) {
    ReaderBlock& b = snap->blocks[i];
    if (b.type == ReaderBlockType::Paragraph || b.type == ReaderBlockType::Heading) {
      b.textHash = TextHashV1(snap->BlockText(i));
    }
  }
  ReindexSnapshot(snap.get());

  std::lock_guard<std::mutex> lock(mutex_);
  snap->documentId = "rdr_" + std::to_string(nextId_++);
  snap->revision = 1;
  const std::string id = snap->documentId;
  docs_[id] = std::move(snap);
  return id;
}

bool ReaderRegistry::InsertSection(const std::string& documentId,
                                   const ReaderAppSectionInput& input, ReaderError* err) {
  if (input.id.rfind("app:", 0) != 0 || !ValidKeyChars(input.id.substr(4))) {
    SetErr(err, kErrReaderInvalidArgument,
           "App section id must be app:<id> with [A-Za-z0-9_-]: " + input.id);
    return false;
  }
  std::unordered_set<std::string> keys;
  for (const auto& b : input.blocks) {
    if (!ValidKeyChars(b.key) || !keys.insert(b.key).second) {
      SetErr(err, kErrReaderInvalidArgument, "Invalid or duplicate block key: " + b.key);
      return false;
    }
    if (b.type == ReaderBlockType::Image) {
      SetErr(err, kErrReaderInvalidArgument, "App sections cannot contain image blocks");
      return false;
    }
  }
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = docs_.find(documentId);
  if (it == docs_.end()) {
    SetErr(err, kErrReaderNotFound, "Reader document not found: " + documentId);
    return false;
  }
  const ReaderSnapshot& cur = *it->second;
  if (cur.SectionIndex(input.id) >= 0) {
    SetErr(err, kErrReaderInvalidArgument, "Section already exists: " + input.id);
    return false;
  }
  const int afterIdx = cur.SectionIndex(input.after);
  if (afterIdx < 0) {
    SetErr(err, kErrReaderInvalidArgument, "Unknown section to insert after: " + input.after);
    return false;
  }
  auto next = std::make_shared<ReaderSnapshot>(cur);
  ReaderSection sec;
  sec.id = input.id;
  sec.app = true;
  sec.kind = "text";
  sec.title = input.title;
  sec.titleSource = input.title.empty() ? "none" : "app";
  sec.blockCount = static_cast<int>(input.blocks.size());
  std::vector<ReaderBlock> blocks;
  blocks.reserve(input.blocks.size());
  for (const auto& in : input.blocks) {
    ReaderBlock b;
    b.id = input.id + "." + in.key;
    b.fromFile = false;
    b.type = in.type;
    b.headingLevel = in.type == ReaderBlockType::Heading ? std::max(1, std::min(6, in.level)) : 0;
    b.textHash = in.type == ReaderBlockType::Separator ? SeparatorHashV1() : TextHashV1(in.text);
    if (in.type != ReaderBlockType::Separator) SetOwnBlockText(&b, in.text);
    blocks.push_back(std::move(b));
  }
  const ReaderSection& after = cur.sections[afterIdx];
  const int insertAt = after.firstBlock + after.blockCount;
  next->blocks.insert(next->blocks.begin() + insertAt, blocks.begin(), blocks.end());
  next->sections.insert(next->sections.begin() + afterIdx + 1, std::move(sec));
  ReindexSnapshot(next.get());
  next->revision = cur.revision + 1;
  it->second = std::move(next);
  return true;
}

bool ReaderRegistry::RemoveSection(const std::string& documentId, const std::string& sectionId,
                                   ReaderError* err) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = docs_.find(documentId);
  if (it == docs_.end()) {
    SetErr(err, kErrReaderNotFound, "Reader document not found: " + documentId);
    return false;
  }
  const ReaderSnapshot& cur = *it->second;
  const int idx = cur.SectionIndex(sectionId);
  if (idx < 0 || !cur.sections[idx].app) {
    SetErr(err, kErrReaderInvalidArgument, "Only app sections can be removed: " + sectionId);
    return false;
  }
  auto next = std::make_shared<ReaderSnapshot>(cur);
  const ReaderSection& sec = cur.sections[idx];
  next->blocks.erase(next->blocks.begin() + sec.firstBlock,
                     next->blocks.begin() + sec.firstBlock + sec.blockCount);
  next->sections.erase(next->sections.begin() + idx);
  ReindexSnapshot(next.get());
  next->revision = cur.revision + 1;
  it->second = std::move(next);
  return true;
}

std::shared_ptr<const ReaderSnapshot> ReaderRegistry::Snapshot(const std::string& documentId) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = docs_.find(documentId);
  return it == docs_.end() ? nullptr : it->second;
}

bool ReaderRegistry::Release(const std::string& documentId) {
  std::lock_guard<std::mutex> lock(mutex_);
  return docs_.erase(documentId) > 0;
}

}  // namespace reader
}  // namespace sherpa_onnx
