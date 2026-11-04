#pragma once

/**
 * Minimal JSON encode/decode for TxtSpatialSpan arrays (Android JNI bridge).
 * Schema matches iOS txtSpatialSpanToDict / Kotlin TextSpatialSpan.
 */

#include "TxtLiveEntry.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <sstream>
#include <string>
#include <vector>

namespace txt_span_json {
namespace detail {

inline void appendEscaped(std::ostringstream &out, const std::string &s) {
  out << '"';
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out << "\\\"";
        break;
      case '\\':
        out << "\\\\";
        break;
      case '\b':
        out << "\\b";
        break;
      case '\f':
        out << "\\f";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out << buf;
        } else {
          out << static_cast<char>(c);
        }
        break;
    }
  }
  out << '"';
}

inline void skipWs(const char *&p, const char *end) {
  while (p < end && std::isspace(static_cast<unsigned char>(*p))) ++p;
}

inline bool matchChar(const char *&p, const char *end, char c) {
  skipWs(p, end);
  if (p < end && *p == c) {
    ++p;
    return true;
  }
  return false;
}

inline bool parseString(const char *&p, const char *end, std::string *out) {
  skipWs(p, end);
  if (p >= end || *p != '"') return false;
  ++p;
  out->clear();
  while (p < end) {
    char c = *p++;
    if (c == '"') return true;
    if (c == '\\' && p < end) {
      char e = *p++;
      switch (e) {
        case '"':
        case '\\':
        case '/':
          out->push_back(e);
          break;
        case 'b':
          out->push_back('\b');
          break;
        case 'f':
          out->push_back('\f');
          break;
        case 'n':
          out->push_back('\n');
          break;
        case 'r':
          out->push_back('\r');
          break;
        case 't':
          out->push_back('\t');
          break;
        case 'u':
          if (p + 4 <= end) {
            unsigned code = 0;
            for (int i = 0; i < 4; ++i) {
              char h = *p++;
              code <<= 4;
              if (h >= '0' && h <= '9')
                code |= (unsigned)(h - '0');
              else if (h >= 'a' && h <= 'f')
                code |= (unsigned)(h - 'a' + 10);
              else if (h >= 'A' && h <= 'F')
                code |= (unsigned)(h - 'A' + 10);
              else
                return false;
            }
            if (code < 0x80) {
              out->push_back(static_cast<char>(code));
            } else if (code < 0x800) {
              out->push_back(static_cast<char>(0xC0 | (code >> 6)));
              out->push_back(static_cast<char>(0x80 | (code & 0x3F)));
            } else {
              out->push_back(static_cast<char>(0xE0 | (code >> 12)));
              out->push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
              out->push_back(static_cast<char>(0x80 | (code & 0x3F)));
            }
          } else {
            return false;
          }
          break;
        default:
          out->push_back(e);
          break;
      }
    } else {
      out->push_back(c);
    }
  }
  return false;
}

inline bool parseNumber(const char *&p, const char *end, double *out) {
  skipWs(p, end);
  const char *start = p;
  if (p < end && (*p == '-' || *p == '+')) ++p;
  if (p >= end || !std::isdigit(static_cast<unsigned char>(*p))) return false;
  while (p < end && std::isdigit(static_cast<unsigned char>(*p))) ++p;
  if (p < end && *p == '.') {
    ++p;
    while (p < end && std::isdigit(static_cast<unsigned char>(*p))) ++p;
  }
  if (p < end && (*p == 'e' || *p == 'E')) {
    ++p;
    if (p < end && (*p == '-' || *p == '+')) ++p;
    while (p < end && std::isdigit(static_cast<unsigned char>(*p))) ++p;
  }
  try {
    *out = std::stod(std::string(start, p));
  } catch (...) {
    return false;
  }
  return true;
}

inline bool skipValue(const char *&p, const char *end);

inline bool skipObjectOrArray(const char *&p, const char *end, char open, char close) {
  if (!matchChar(p, end, open)) return false;
  skipWs(p, end);
  if (matchChar(p, end, close)) return true;
  while (p < end) {
    if (!skipValue(p, end)) return false;
    skipWs(p, end);
    if (matchChar(p, end, close)) return true;
    if (!matchChar(p, end, ',')) return false;
  }
  return false;
}

inline bool skipValue(const char *&p, const char *end) {
  skipWs(p, end);
  if (p >= end) return false;
  if (*p == '"') {
    std::string tmp;
    return parseString(p, end, &tmp);
  }
  if (*p == '{') return skipObjectOrArray(p, end, '{', '}');
  if (*p == '[') return skipObjectOrArray(p, end, '[', ']');
  if (*p == 't' || *p == 'f' || *p == 'n') {
    if (end - p >= 4 && std::string(p, p + 4) == "true") {
      p += 4;
      return true;
    }
    if (end - p >= 5 && std::string(p, p + 5) == "false") {
      p += 5;
      return true;
    }
    if (end - p >= 4 && std::string(p, p + 4) == "null") {
      p += 4;
      return true;
    }
    return false;
  }
  double tmp = 0;
  return parseNumber(p, end, &tmp);
}

inline bool parseQuad(const char *&p, const char *end, float quad[8]) {
  if (!matchChar(p, end, '[')) return false;
  for (int i = 0; i < 8; ++i) {
    double v = 0;
    if (!parseNumber(p, end, &v)) return false;
    quad[i] = static_cast<float>(v);
    skipWs(p, end);
    if (i < 7) {
      if (!matchChar(p, end, ',')) return false;
    }
  }
  return matchChar(p, end, ']');
}

inline bool parseSpanObject(const char *&p, const char *end, TxtSpatialSpan *span) {
  if (!matchChar(p, end, '{')) return false;
  *span = TxtSpatialSpan{};
  skipWs(p, end);
  if (matchChar(p, end, '}')) return true;
  while (p < end) {
    std::string key;
    if (!parseString(p, end, &key)) return false;
    if (!matchChar(p, end, ':')) return false;
    skipWs(p, end);
    if (key == "utf16Start") {
      double v = 0;
      if (!parseNumber(p, end, &v)) return false;
      span->utf16Start = (int)v;
    } else if (key == "utf16End") {
      double v = 0;
      if (!parseNumber(p, end, &v)) return false;
      span->utf16End = (int)v;
    } else if (key == "level") {
      if (!parseString(p, end, &span->level)) return false;
    } else if (key == "sourceImageBufferId") {
      if (!parseString(p, end, &span->sourceImageBufferId)) return false;
    } else if (key == "frameIndex") {
      double v = 0;
      if (!parseNumber(p, end, &v)) return false;
      span->frameIndex = (int)v;
    } else if (key == "quad") {
      if (!parseQuad(p, end, span->quad)) return false;
    } else if (key == "origin") {
      if (!parseString(p, end, &span->origin)) return false;
    } else if (key == "confidence") {
      double v = 0;
      if (!parseNumber(p, end, &v)) return false;
      span->hasConfidence = true;
      span->confidence = static_cast<float>(v);
    } else if (key == "pageNumber") {
      double v = 0;
      if (!parseNumber(p, end, &v)) return false;
      span->hasPageNumber = true;
      span->pageNumber = (int)v;
    } else if (key == "ptsMs") {
      double v = 0;
      if (!parseNumber(p, end, &v)) return false;
      span->hasPtsMs = true;
      span->ptsMs = v;
    } else if (key == "pageWidth") {
      double v = 0;
      if (!parseNumber(p, end, &v)) return false;
      span->hasPageWidth = true;
      span->pageWidth = static_cast<float>(v);
    } else if (key == "pageHeight") {
      double v = 0;
      if (!parseNumber(p, end, &v)) return false;
      span->hasPageHeight = true;
      span->pageHeight = static_cast<float>(v);
    } else if (key == "sectionIndex") {
      double v = 0;
      if (!parseNumber(p, end, &v)) return false;
      span->hasSectionIndex = true;
      span->sectionIndex = (int)v;
    } else if (key == "href") {
      if (!parseString(p, end, &span->href)) return false;
    } else {
      if (!skipValue(p, end)) return false;
    }
    skipWs(p, end);
    if (matchChar(p, end, '}')) return true;
    if (!matchChar(p, end, ',')) return false;
  }
  return false;
}

}  // namespace detail

inline std::string encode(const std::vector<TxtSpatialSpan> &spans) {
  std::ostringstream out;
  out << '[';
  for (size_t i = 0; i < spans.size(); ++i) {
    if (i > 0) out << ',';
    const TxtSpatialSpan &s = spans[i];
    out << '{';
    out << "\"utf16Start\":" << s.utf16Start;
    out << ",\"utf16End\":" << s.utf16End;
    out << ",\"level\":";
    detail::appendEscaped(out, s.level.empty() ? "line" : s.level);
    out << ",\"sourceImageBufferId\":";
    detail::appendEscaped(out, s.sourceImageBufferId);
    out << ",\"frameIndex\":" << s.frameIndex;
    out << ",\"quad\":[";
    for (int q = 0; q < 8; ++q) {
      if (q > 0) out << ',';
      out << s.quad[q];
    }
    out << "],\"origin\":";
    detail::appendEscaped(out, s.origin.empty() ? "ocr" : s.origin);
    if (s.hasConfidence) out << ",\"confidence\":" << s.confidence;
    if (s.hasPageNumber) out << ",\"pageNumber\":" << s.pageNumber;
    if (s.hasPtsMs) out << ",\"ptsMs\":" << s.ptsMs;
    if (s.hasPageWidth) out << ",\"pageWidth\":" << s.pageWidth;
    if (s.hasPageHeight) out << ",\"pageHeight\":" << s.pageHeight;
    if (s.hasSectionIndex) out << ",\"sectionIndex\":" << s.sectionIndex;
    if (!s.href.empty()) {
      out << ",\"href\":";
      detail::appendEscaped(out, s.href);
    }
    out << '}';
  }
  out << ']';
  return out.str();
}

inline bool decode(const std::string &json, std::vector<TxtSpatialSpan> *out) {
  if (!out) return false;
  out->clear();
  if (json.empty()) return true;
  const char *p = json.data();
  const char *end = json.data() + json.size();
  if (!detail::matchChar(p, end, '[')) return false;
  detail::skipWs(p, end);
  if (detail::matchChar(p, end, ']')) return true;
  while (p < end) {
    TxtSpatialSpan span;
    if (!detail::parseSpanObject(p, end, &span)) return false;
    out->push_back(std::move(span));
    detail::skipWs(p, end);
    if (detail::matchChar(p, end, ']')) return true;
    if (!detail::matchChar(p, end, ',')) return false;
  }
  return false;
}

inline std::string encodeSlice(const std::vector<TxtSpatialSpan> &spans, int start, int maxCount) {
  if (start < 0 || maxCount <= 0 || start >= (int)spans.size()) {
    return "[]";
  }
  int end = std::min(start + maxCount, (int)spans.size());
  std::vector<TxtSpatialSpan> slice(spans.begin() + start, spans.begin() + end);
  return encode(slice);
}

inline std::string encodeTokensSlice(const std::vector<std::string> &tokens, int start, int maxCount) {
  std::ostringstream out;
  out << '[';
  if (start < 0 || maxCount <= 0 || start >= (int)tokens.size()) {
    out << ']';
    return out.str();
  }
  int end = std::min(start + maxCount, (int)tokens.size());
  for (int i = start; i < end; ++i) {
    if (i > start) out << ',';
    detail::appendEscaped(out, tokens[(size_t)i]);
  }
  out << ']';
  return out.str();
}

inline std::string encodeFloatSlice(const std::vector<float> &values, int start, int maxCount) {
  std::ostringstream out;
  out << '[';
  if (start < 0 || maxCount <= 0 || start >= (int)values.size()) {
    out << ']';
    return out.str();
  }
  int end = std::min(start + maxCount, (int)values.size());
  for (int i = start; i < end; ++i) {
    if (i > start) out << ',';
    out << values[(size_t)i];
  }
  out << ']';
  return out.str();
}

}  // namespace txt_span_json
