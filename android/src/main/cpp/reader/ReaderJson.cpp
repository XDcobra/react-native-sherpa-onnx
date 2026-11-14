#include "ReaderJson.h"

#include "ReaderTextHash.h"

#include <algorithm>
#include <cstdio>

namespace sherpa_onnx {
namespace reader {

std::string JsonEscape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 2);
  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
  return out;
}

namespace {

void Field(std::string* out, const char* key, const std::string& value, bool* first) {
  if (!*first) out->push_back(',');
  *first = false;
  *out += JsonEscape(key);
  out->push_back(':');
  *out += JsonEscape(value);
}

void Field(std::string* out, const char* key, long long value, bool* first) {
  if (!*first) out->push_back(',');
  *first = false;
  *out += JsonEscape(key);
  out->push_back(':');
  *out += std::to_string(value);
}

void FieldBool(std::string* out, const char* key, bool value, bool* first) {
  if (!*first) out->push_back(',');
  *first = false;
  *out += JsonEscape(key);
  *out += value ? ":true" : ":false";
}

}  // namespace

std::string SnapshotSummaryJson(const ReaderSnapshot& snap) {
  std::string out = "{";
  bool first = true;
  Field(&out, "id", snap.documentId, &first);
  Field(&out, "revision", snap.revision, &first);
  Field(&out, "documentKey", snap.documentKey, &first);
  Field(&out, "format", snap.format.empty() ? std::string("epub") : snap.format, &first);
  Field(&out, "structureVersion", snap.structureVersion > 0 ? snap.structureVersion : kStructureVersion, &first);
  Field(&out, "textHashVersion", kTextHashVersion, &first);
  Field(&out, "blockCount", static_cast<long long>(snap.blocks.size()), &first);
  if (!snap.imageBufferId.empty()) Field(&out, "imageBufferId", snap.imageBufferId, &first);
  out += ",\"metadata\":{";
  bool mf = true;
  if (!snap.title.empty()) Field(&out, "title", snap.title, &mf);
  if (!snap.creator.empty()) Field(&out, "creator", snap.creator, &mf);
  if (!snap.language.empty()) Field(&out, "language", snap.language, &mf);
  out += "},\"sections\":[";
  for (size_t i = 0; i < snap.sections.size(); ++i) {
    const ReaderSection& s = snap.sections[i];
    if (i) out.push_back(',');
    out.push_back('{');
    bool sf = true;
    Field(&out, "id", s.id, &sf);
    if (!s.app) Field(&out, "sectionIndex", s.sectionIndex, &sf);
    Field(&out, "origin", s.app ? std::string("app") : std::string("file"), &sf);
    Field(&out, "kind", s.kind, &sf);
    if (!s.href.empty()) Field(&out, "href", s.href, &sf);
    if (!s.title.empty()) Field(&out, "title", s.title, &sf);
    Field(&out, "titleSource", s.titleSource, &sf);
    if (!s.label.empty()) Field(&out, "label", s.label, &sf);
    Field(&out, "blockCount", s.blockCount, &sf);
    if (s.blockCount > 0) {
      Field(&out, "firstBlockId", snap.blocks[s.firstBlock].id, &sf);
      Field(&out, "lastBlockId", snap.blocks[s.firstBlock + s.blockCount - 1].id, &sf);
    } else {
      Field(&out, "firstBlockId", std::string(), &sf);
      Field(&out, "lastBlockId", std::string(), &sf);
    }
    out.push_back('}');
  }
  out += "]}";
  return out;
}

std::string BlocksJson(const ReaderSnapshot& snap, int start, int max, bool includeText) {
  const int n = static_cast<int>(snap.blocks.size());
  const int from = std::max(0, std::min(start, n));
  const int to = std::min(n, from + std::max(0, max));
  std::string out = "[";
  for (int i = from; i < to; ++i) {
    const ReaderBlock& b = snap.blocks[i];
    if (i > from) out.push_back(',');
    out.push_back('{');
    bool f = true;
    Field(&out, "id", b.id, &f);
    Field(&out, "sectionId", snap.sections[b.section].id, &f);
    Field(&out, "index", i, &f);
    Field(&out, "type", ReaderBlockTypeName(b.type), &f);
    if (b.headingLevel > 0) Field(&out, "headingLevel", b.headingLevel, &f);
    Field(&out, "textHash", b.textHash, &f);
    if (b.fromFile && b.utf16End > b.utf16Start) {
      out += ",\"textRange\":{\"start\":" + std::to_string(b.utf16Start) +
             ",\"end\":" + std::to_string(b.utf16End) + "}";
    }
    if (b.type == ReaderBlockType::Image || b.type == ReaderBlockType::Page) {
      if (!b.imageHref.empty()) Field(&out, "imageHref", b.imageHref, &f);
      if (b.imageFrame >= 0) Field(&out, "imageFrameIndex", b.imageFrame, &f);
      if (b.hasAlt) Field(&out, "alt", b.alt, &f);
    }
    if (b.flags & kBlockFurniture) FieldBool(&out, "furniture", true, &f);
    if (b.hasRect) {
      char buf[96];
      std::snprintf(buf, sizeof(buf), ",\"rect\":[%.4f,%.4f,%.4f,%.4f]", b.rect[0], b.rect[1],
                    b.rect[2], b.rect[3]);
      out += buf;
    }
    if (includeText && (b.type == ReaderBlockType::Paragraph || b.type == ReaderBlockType::Heading)) {
      Field(&out, "text", snap.BlockText(i), &f);
    }
    out.push_back('}');
  }
  out.push_back(']');
  return out;
}

std::string PagesJson(const ReaderSnapshot& snap) {
  std::string out = "{";
  bool first = true;
  Field(&out, "imageBufferId", snap.imageBufferId, &first);
  out += ",\"pages\":[";
  bool firstPage = true;
  for (const ReaderSection& sec : snap.sections) {
    const bool pageSection = sec.kind == "page";
    const bool imageSection = sec.kind == "image";
    if (!pageSection && !imageSection) continue;
    for (int k = 0; k < sec.blockCount; ++k) {
      const int i = sec.firstBlock + k;
      const ReaderBlock& b = snap.blocks[i];
      const bool candidate = b.imageFrame >= 0 && (b.type == ReaderBlockType::Page ||
                                                   (imageSection && b.type == ReaderBlockType::Image));
      if (!candidate) continue;
      bool hasText = false;
      if (b.type == ReaderBlockType::Page) {
        for (int j = sec.firstBlock; j < sec.firstBlock + sec.blockCount; ++j) {
          const ReaderBlockType t = snap.blocks[j].type;
          if ((t == ReaderBlockType::Paragraph || t == ReaderBlockType::Heading) &&
              snap.BlockLength(j) > 0) {
            hasText = true;
          }
        }
      } else {
        hasText = i + 1 < static_cast<int>(snap.blocks.size()) &&
                  snap.blocks[i + 1].id.rfind(b.id + ".t", 0) == 0;
      }
      if (!firstPage) out.push_back(',');
      firstPage = false;
      out.push_back('{');
      bool f = true;
      Field(&out, "sectionId", sec.id, &f);
      Field(&out, "blockId", b.id, &f);
      Field(&out, "frame", b.imageFrame, &f);
      FieldBool(&out, "hasText", hasText, &f);
      out.push_back('}');
    }
  }
  out += "]}";
  return out;
}

std::string TocJson(const ReaderSnapshot& snap) {
  std::string out = "[";
  bool any = false;
  auto entry = [&](const std::string& title, int level, int block) {
    if (any) out.push_back(',');
    any = true;
    out += "{\"title\":" + JsonEscape(title) + ",\"level\":" + std::to_string(level) +
           ",\"sectionId\":" + JsonEscape(snap.sections[snap.blocks[block].section].id) +
           ",\"blockId\":" + JsonEscape(snap.blocks[block].id) + "}";
  };
  if (!snap.toc.empty()) {
    for (const auto& e : snap.toc) {
      const int b = snap.BlockIndex(e.blockId);
      if (b >= 0) entry(e.title, e.level, b);
    }
  } else {
    for (const auto& sec : snap.sections) {
      if (sec.title.empty() || sec.blockCount == 0) continue;
      entry(sec.title, 1, sec.firstBlock);
    }
  }
  out.push_back(']');
  return out;
}

namespace {

std::string LocatorJson(const ReaderSnapshot& snap, int block, int offset) {
  return "{\"sectionId\":" + JsonEscape(snap.sections[snap.blocks[block].section].id) +
         ",\"blockId\":" + JsonEscape(snap.blocks[block].id) +
         ",\"offset\":" + std::to_string(offset) + "}";
}

template <typename Map>
std::string RangesJson(const ReaderSnapshot& snap, const std::vector<int>& starts,
                       const std::vector<int>& ends, Map map) {
  const size_t n = std::min(starts.size(), ends.size());
  std::string out = "[";
  out.reserve(n * 96);
  for (size_t i = 0; i < n; ++i) {
    if (i > 0) out.push_back(',');
    int a = -1, ao = 0, z = -1, zo = 0;
    if (!map(starts[i], ends[i], &a, &ao, &z, &zo)) {
      out += "null";
      continue;
    }
    out += "{\"from\":" + LocatorJson(snap, a, ao) + ",\"to\":" + LocatorJson(snap, z, zo) + "}";
  }
  out.push_back(']');
  return out;
}

}  // namespace

std::string TextRangesJson(const ReaderSnapshot& snap, const std::vector<int>& starts,
                           const std::vector<int>& ends) {
  return RangesJson(snap, starts, ends, [&](int s, int e, int* a, int* ao, int* z, int* zo) {
    return snap.MapTextRange(s, e, a, ao, z, zo);
  });
}

std::string SliceRangesJson(const ReaderSnapshot& snap, const ReaderTextSlice& slice,
                            const std::vector<int>& starts, const std::vector<int>& ends) {
  return RangesJson(snap, starts, ends, [&](int s, int e, int* a, int* ao, int* z, int* zo) {
    return MapSliceRange(slice, snap, s, e, a, ao, z, zo);
  });
}

std::string SliceJson(const ReaderSnapshot& snap, const ReaderTextSlice& slice,
                      const std::string& bufferId) {
  const ReaderSliceEntry& first = slice.entries.front();
  const ReaderSliceEntry& last = slice.entries.back();
  const int a = snap.BlockIndex(first.blockId);
  const int z = snap.BlockIndex(last.blockId);
  return "{\"bufferId\":" + JsonEscape(bufferId) + ",\"length\":" + std::to_string(slice.length) +
         ",\"from\":" + LocatorJson(snap, a, first.blockOffset) +
         ",\"to\":" + LocatorJson(snap, z, last.blockOffset + last.length) + "}";
}

}  // namespace reader
}  // namespace sherpa_onnx
