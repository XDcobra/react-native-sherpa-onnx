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
  Field(&out, "structureVersion", kStructureVersion, &first);
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
    if (b.type == ReaderBlockType::Image) {
      Field(&out, "imageHref", b.imageHref, &f);
      if (b.imageFrame >= 0) Field(&out, "imageFrameIndex", b.imageFrame, &f);
      if (b.hasAlt) Field(&out, "alt", b.alt, &f);
    }
    if (includeText && (b.type == ReaderBlockType::Paragraph || b.type == ReaderBlockType::Heading)) {
      Field(&out, "text", snap.BlockText(i), &f);
    }
    out.push_back('}');
  }
  out.push_back(']');
  return out;
}

}  // namespace reader
}  // namespace sherpa_onnx
