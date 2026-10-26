#include "NemotronParseMarkup.h"

#include "../OcrTextUtils.h"

#include <cctype>
#include <cmath>
#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {
namespace {

void StripTrailingEos(std::string& text) {
  while (text.size() >= 4 && text.compare(text.size() - 4, 4, "</s>") == 0) {
    text.resize(text.size() - 4);
  }
  while (!text.empty() &&
         (text.back() == '\n' || text.back() == '\r' || text.back() == ' ')) {
    text.pop_back();
  }
}

bool StartsWith(const std::string& s, size_t i, const char* lit) {
  const size_t n = std::char_traits<char>::length(lit);
  return i + n <= s.size() && s.compare(i, n, lit) == 0;
}

bool ParseTaggedFloat(const std::string& s, size_t& i, const char* open, float& value) {
  if (!StartsWith(s, i, open)) return false;
  size_t j = i + std::char_traits<char>::length(open);
  size_t end = j;
  while (end < s.size() && s[end] != '>') ++end;
  if (end >= s.size()) return false;
  try {
    value = std::stof(s.substr(j, end - j));
  } catch (const std::exception&) {
    return false;
  }
  i = end + 1;
  return true;
}

bool ConsumeClass(const std::string& s, size_t& i) {
  if (!StartsWith(s, i, "<class_")) return false;
  size_t end = i + 7;
  while (end < s.size() && s[end] != '>') ++end;
  if (end >= s.size()) return false;
  i = end + 1;
  return true;
}

OcrQuad BoxQuad(float x0, float y0, float x1, float y1, int w, int h) {
  const float l = std::min(x0, x1) * static_cast<float>(w);
  const float t = std::min(y0, y1) * static_cast<float>(h);
  const float r = std::max(x0, x1) * static_cast<float>(w);
  const float b = std::max(y0, y1) * static_cast<float>(h);
  OcrQuad q;
  q.xy[0] = l;
  q.xy[1] = t;
  q.xy[2] = r;
  q.xy[3] = t;
  q.xy[4] = r;
  q.xy[5] = b;
  q.xy[6] = l;
  q.xy[7] = b;
  return q;
}

std::string StripTags(const std::string& raw) {
  std::string out;
  out.reserve(raw.size());
  for (size_t i = 0; i < raw.size();) {
    float dummy = 0.f;
    size_t cursor = i;
    if (ParseTaggedFloat(raw, cursor, "<x_", dummy) ||
        ParseTaggedFloat(raw, cursor, "<y_", dummy)) {
      i = cursor;
      continue;
    }
    cursor = i;
    if (ConsumeClass(raw, cursor) || StartsWith(raw, i, "<s>") ||
        StartsWith(raw, i, "</s>")) {
      if (StartsWith(raw, i, "<s>")) {
        i += 3;
      } else if (StartsWith(raw, i, "</s>")) {
        i += 4;
      } else {
        i = cursor;
      }
      continue;
    }
    out.push_back(raw[i]);
    ++i;
  }
  return out;
}

}  // namespace

NemotronParseMarkup ParseNemotronMarkup(const std::string& generated, int frame_w,
                                        int frame_h, int frame_index) {
  NemotronParseMarkup out;
  out.raw_utf8 = generated;
  StripTrailingEos(out.raw_utf8);
  out.markdown_utf8 = StripTags(out.raw_utf8);
  out.text_utf8 = out.markdown_utf8;

  int utf16 = 0;
  size_t i = 0;
  const std::string& s = out.raw_utf8;
  while (i < s.size()) {
    float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    size_t cursor = i;
    if (!ParseTaggedFloat(s, cursor, "<x_", x0)) {
      ++i;
      continue;
    }
    if (!ParseTaggedFloat(s, cursor, "<y_", y0)) {
      ++i;
      continue;
    }
    const size_t body_begin = cursor;
    size_t scan = cursor;
    bool found_end = false;
    while (scan < s.size()) {
      size_t look = scan;
      if (ParseTaggedFloat(s, look, "<x_", x1) && ParseTaggedFloat(s, look, "<y_", y1)) {
        size_t after = look;
        ConsumeClass(s, after);
        found_end = true;
        const std::string body = s.substr(body_begin, scan - body_begin);
        const std::string plain = StripTags(body);
        const int start = Utf8ToUtf16Length(StripTags(s.substr(0, body_begin)));
        const int end = start + Utf8ToUtf16Length(plain);
        OcrSpan span;
        span.utf16_start = start;
        span.utf16_end = std::max(end, start);
        span.quad = BoxQuad(x0, y0, x1, y1, frame_w, frame_h);
        span.confidence = 1.f;
        span.frame_index = frame_index;
        span.level = OcrSpanLevel::kLine;
        out.spans.push_back(span);
        (void)utf16;
        i = after;
        found_end = true;
        break;
      }
      ++scan;
    }
    if (!found_end) break;
  }
  return out;
}

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
