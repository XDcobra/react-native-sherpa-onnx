#include "NemotronParseMarkup.h"

#include "../OcrGeometry.h"
#include "../OcrTextUtils.h"
#include "../markup/OcrElementKind.h"
#include "NemotronParseLog.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <string>
#include <vector>

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

bool ConsumeClass(const std::string& s, size_t& i, std::string* token = nullptr) {
  if (!StartsWith(s, i, "<class_")) return false;
  size_t end = i + 7;
  while (end < s.size() && s[end] != '>') ++end;
  if (end >= s.size()) return false;
  if (token) *token = s.substr(i, end + 1 - i);
  i = end + 1;
  return true;
}

OcrQuad BoxQuad(float x0, float y0, float x1, float y1, int w, int h) {
  OcrNormRect norm;
  norm.x0 = x0;
  norm.y0 = y0;
  norm.x1 = x1;
  norm.y1 = y1;
  return NormToQuad(norm, w, h);
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

void TrimAsciiWs(std::string& s) {
  size_t a = 0;
  while (a < s.size() && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
  size_t b = s.size();
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
  s = s.substr(a, b - a);
}

bool ConsumeBraced(const std::string& s, size_t& i) {
  if (i >= s.size() || s[i] != '{') return false;
  int depth = 0;
  do {
    if (s[i] == '{') ++depth;
    else if (s[i] == '}') --depth;
    ++i;
  } while (i < s.size() && depth > 0);
  return depth == 0;
}

bool ConsumeBeginTabular(const std::string& s, size_t& i) {
  size_t j = i;
  if (StartsWith(s, j, "\\begin{tabular*}")) {
    j += 16;
  } else if (StartsWith(s, j, "\\begin{tabular}")) {
    j += 15;
  } else {
    return false;
  }
  if (j < s.size() && s[j] == '[') {
    const size_t close = s.find(']', j);
    if (close == std::string::npos) return false;
    j = close + 1;
  }
  if (j < s.size() && s[j] == '{') ConsumeBraced(s, j);
  if (j < s.size() && s[j] == '{') ConsumeBraced(s, j);
  i = j;
  return true;
}

bool ConsumeEndTabular(const std::string& s, size_t& i) {
  if (StartsWith(s, i, "\\end{tabular*}")) {
    i += 14;
    return true;
  }
  if (StartsWith(s, i, "\\end{tabular}")) {
    i += 13;
    return true;
  }
  return false;
}

size_t FindEndTabular(const std::string& s, size_t from) {
  const size_t star = s.find("\\end{tabular*}", from);
  const size_t plain = s.find("\\end{tabular}", from);
  if (star == std::string::npos) return plain;
  if (plain == std::string::npos) return star;
  return std::min(star, plain);
}

bool ConsumeRule(const std::string& s, size_t& i) {
  static const char* kRules[] = {"\\hline", "\\toprule", "\\midrule",
                                 "\\bottomrule"};
  for (const char* rule : kRules) {
    if (StartsWith(s, i, rule)) {
      i += std::char_traits<char>::length(rule);
      if (i < s.size() && s[i] == '*') ++i;
      return true;
    }
  }
  if (StartsWith(s, i, "\\cline")) {
    i += 6;
    if (i < s.size() && s[i] == '{') ConsumeBraced(s, i);
    return true;
  }
  return false;
}

void StripOneArgCommand(std::string& cell, const char* cmd) {
  const size_t cmd_len = std::char_traits<char>::length(cmd);
  size_t pos = 0;
  while ((pos = cell.find(cmd, pos)) != std::string::npos) {
    size_t j = pos + cmd_len;
    if (j < cell.size() && cell[j] == '{') {
      size_t inner = j;
      if (ConsumeBraced(cell, inner) && inner > j + 1) {
        const std::string arg = cell.substr(j + 1, inner - j - 2);
        cell.replace(pos, inner - pos, arg);
        continue;
      }
    }
    ++pos;
  }
}

std::string CleanLatexCell(std::string cell) {
  StripOneArgCommand(cell, "\\textbf");
  StripOneArgCommand(cell, "\\textit");
  StripOneArgCommand(cell, "\\mathrm");
  StripOneArgCommand(cell, "\\emph");
  StripOneArgCommand(cell, "\\text");
  std::string out;
  out.reserve(cell.size());
  for (size_t i = 0; i < cell.size(); ++i) {
    if (cell[i] == '\\' && i + 1 < cell.size() &&
        (cell[i + 1] == '&' || cell[i + 1] == '%' || cell[i + 1] == '_' ||
         cell[i + 1] == '#' || cell[i + 1] == '{' || cell[i + 1] == '}')) {
      out.push_back(cell[i + 1]);
      ++i;
      continue;
    }
    if (cell[i] == '~') {
      out.push_back(' ');
      continue;
    }
    if (cell[i] == '$') continue;
    out.push_back(cell[i]);
  }
  TrimAsciiWs(out);
  return out;
}

std::vector<std::vector<std::string>> ParseTabularRows(const std::string& body) {
  std::vector<std::vector<std::string>> rows;
  std::vector<std::string> row;
  std::string cell;
  auto flush_cell = [&]() {
    row.push_back(CleanLatexCell(cell));
    cell.clear();
  };
  auto flush_row = [&]() {
    flush_cell();
    bool any = false;
    for (const auto& c : row) {
      if (!c.empty()) any = true;
    }
    if (any) rows.push_back(row);
    row.clear();
  };
  for (size_t i = 0; i < body.size();) {
    if (ConsumeRule(body, i)) continue;
    if (body[i] == '\\' && i + 1 < body.size() && body[i + 1] == '\\') {
      i += 2;
      if (i < body.size() && body[i] == '[') {
        const size_t close = body.find(']', i);
        if (close != std::string::npos) i = close + 1;
      }
      flush_row();
      continue;
    }
    if (body[i] == '&' && (i == 0 || body[i - 1] != '\\')) {
      flush_cell();
      ++i;
      continue;
    }
    cell.push_back(body[i]);
    ++i;
  }
  if (!cell.empty() || !row.empty()) flush_row();
  return rows;
}

std::string EscapeGfmCell(const std::string& cell) {
  std::string out;
  out.reserve(cell.size());
  for (char c : cell) {
    if (c == '|') out += "\\|";
    else if (c == '\n' || c == '\r') out.push_back(' ');
    else out.push_back(c);
  }
  return out;
}

std::string GfmTable(const std::vector<std::vector<std::string>>& rows) {
  size_t cols = 0;
  for (const auto& row : rows) cols = std::max(cols, row.size());
  if (cols == 0) return {};
  auto join = [&](const std::vector<std::string>& row) {
    std::string line = "|";
    for (size_t c = 0; c < cols; ++c) {
      line += " ";
      line += c < row.size() ? EscapeGfmCell(row[c]) : "";
      line += " |";
    }
    return line;
  };
  std::string md = join(rows[0]);
  md += "\n|";
  for (size_t c = 0; c < cols; ++c) md += " --- |";
  for (size_t r = 1; r < rows.size(); ++r) {
    md += "\n";
    md += join(rows[r]);
  }
  return md;
}

std::string PlainTable(const std::vector<std::vector<std::string>>& rows) {
  std::string text;
  for (size_t r = 0; r < rows.size(); ++r) {
    if (r) text.push_back('\n');
    bool first = true;
    for (const auto& cell : rows[r]) {
      if (cell.empty()) continue;
      if (!first) text.push_back(' ');
      text += cell;
      first = false;
    }
  }
  return text;
}

struct BodyViews {
  std::string markdown;
  std::string text;
  int tables = 0;
};

void TrimTrailingWs(std::string& s) {
  while (!s.empty() &&
         (s.back() == '\n' || s.back() == '\r' || s.back() == ' ')) {
    s.pop_back();
  }
}

BodyViews RewriteStripped(const std::string& stripped) {
  BodyViews views;
  size_t i = 0;
  while (i < stripped.size()) {
    if (ConsumeBeginTabular(stripped, i)) {
      const size_t end = FindEndTabular(stripped, i);
      const size_t body_end = end == std::string::npos ? stripped.size() : end;
      const auto rows = ParseTabularRows(stripped.substr(i, body_end - i));
      if (!rows.empty()) {
        if (!views.markdown.empty() && views.markdown.back() != '\n') {
          views.markdown.push_back('\n');
        }
        if (!views.text.empty() && views.text.back() != '\n') {
          views.text.push_back('\n');
        }
        views.markdown += GfmTable(rows);
        views.text += PlainTable(rows);
        ++views.tables;
      }
      i = body_end;
      ConsumeEndTabular(stripped, i);
      continue;
    }
    views.markdown.push_back(stripped[i]);
    views.text.push_back(stripped[i]);
    ++i;
  }
  TrimTrailingWs(views.markdown);
  TrimTrailingWs(views.text);
  return views;
}

}  // namespace

NemotronParseMarkup ParseNemotronMarkup(const std::string& generated, int frame_w,
                                        int frame_h, int frame_index) {
  NemotronParseMarkup out;
  out.raw_utf8 = generated;
  StripTrailingEos(out.raw_utf8);
  const BodyViews views = RewriteStripped(StripTags(out.raw_utf8));
  out.markdown_utf8 = views.markdown;
  out.text_utf8 = views.text;

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
        std::string class_token;
        ConsumeClass(s, after, &class_token);
        found_end = true;
        const std::string body = s.substr(body_begin, scan - body_begin);
        const BodyViews prefix_v =
            RewriteStripped(StripTags(s.substr(0, body_begin)));
        const BodyViews body_v = RewriteStripped(StripTags(body));
        size_t byte_start = prefix_v.text.size();
        if (!body_v.text.empty() && byte_start <= out.text_utf8.size() &&
            out.text_utf8.compare(byte_start, body_v.text.size(),
                                  body_v.text) != 0 &&
            byte_start < out.text_utf8.size() &&
            out.text_utf8[byte_start] == '\n') {
          ++byte_start;
        }
        const int start =
            Utf8ToUtf16Length(out.text_utf8.substr(0, byte_start));
        const int end = start + Utf8ToUtf16Length(body_v.text);
        OcrSpan span;
        span.utf16_start = start;
        span.utf16_end = std::max(end, start);
        span.quad = BoxQuad(x0, y0, x1, y1, frame_w, frame_h);
        span.confidence = 1.f;
        span.frame_index = frame_index;
        span.level = OcrSpanLevel::kLine;
        out.spans.push_back(span);
        if (!class_token.empty()) {
          const auto kind = FromNemotronClass(class_token);
          if (!kind.ok) {
            throw OcrCodedError(kind.error_code.c_str(), kind.error_message);
          }
          OcrLayoutElement element;
          element.kind = kind.kind;
          element.frame_index = frame_index;
          element.has_quad = true;
          element.quad = span.quad;
          if (!body_v.text.empty()) {
            element.has_utf16 = true;
            element.utf16_start = span.utf16_start;
            element.utf16_end = span.utf16_end;
          }
          out.elements.push_back(element);
        }
        (void)utf16;
        i = after;
        found_end = true;
        break;
      }
      ++scan;
    }
    if (!found_end) break;
  }
  OCR_LOGI("nemotron markup tables=%d markdown=%zu text=%zu spans=%zu elements=%zu",
           views.tables, out.markdown_utf8.size(), out.text_utf8.size(),
           out.spans.size(), out.elements.size());
  return out;
}

void ApplyNemotronOutput(OcrResult& result, const NemotronParseMarkup& parsed,
                         const NemotronParseOutput& output) {
  result.raw_utf8 = parsed.raw_utf8;
  result.text_utf8 = parsed.text_utf8;
  result.spans = parsed.spans;
  result.elements = parsed.elements;

  if (output.layout == NemotronParseLayout::kNone) {
    result.spans.clear();
    result.elements.clear();
  } else if (output.layout == NemotronParseLayout::kBoxes) {
    result.elements.clear();
  }

  if (output.text == NemotronParseText::kNone) {
    result.has_content = false;
    result.content = {};
    result.text_utf8.clear();
    for (auto& span : result.spans) {
      span.utf16_start = 0;
      span.utf16_end = 0;
    }
    for (auto& element : result.elements) {
      element.has_utf16 = false;
      element.utf16_start = 0;
      element.utf16_end = 0;
    }
    // boxesAndClasses: geometry lives on elements. boxes: keep zero-length spans.
    if (output.layout != NemotronParseLayout::kBoxes) {
      result.spans.clear();
    }
    return;
  }

  if (output.text == NemotronParseText::kPlain) {
    SetOcrContent(result, OcrContentFormat::kPlain, parsed.text_utf8);
    return;
  }
  SetOcrContent(result, OcrContentFormat::kMarkdown, parsed.markdown_utf8);
}

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
