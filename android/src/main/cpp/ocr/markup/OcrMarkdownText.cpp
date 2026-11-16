#include "OcrMarkdownText.h"

#include "../OcrTextUtils.h"

#include <cctype>

namespace sherpa_onnx {
namespace ocr {

namespace {

std::string Trim(const std::string& s) {
  size_t a = 0;
  while (a < s.size() && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
  size_t b = s.size();
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
  return s.substr(a, b - a);
}

/** Inline cleanup: tags → space, emphasis / code markers removed, spaces collapsed. */
std::string CleanInline(const std::string& line) {
  std::string out;
  out.reserve(line.size());
  for (size_t i = 0; i < line.size();) {
    const char c = line[i];
    if (c == '<') {
      const size_t end = line.find('>', i + 1);
      if (end != std::string::npos && end - i < 64) {
        out.push_back(' ');
        i = end + 1;
        continue;
      }
    }
    if (c == '*' || c == '`') {
      ++i;
      continue;
    }
    if (c == '_' && i + 1 < line.size() && line[i + 1] == '_') {
      i += 2;
      continue;
    }
    out.push_back(c);
    ++i;
  }
  std::string collapsed;
  bool space = false;
  for (unsigned char c : out) {
    if (std::isspace(c)) {
      space = !collapsed.empty();
    } else {
      if (space) collapsed.push_back(' ');
      space = false;
      collapsed.push_back(static_cast<char>(c));
    }
  }
  return collapsed;
}

int HeadingLevel(const std::string& line, size_t* text_at) {
  size_t n = 0;
  while (n < line.size() && line[n] == '#') ++n;
  if (n == 0 || n > 6 || n >= line.size() || line[n] != ' ') return 0;
  *text_at = n + 1;
  return static_cast<int>(n);
}

bool ListMarker(const std::string& line, size_t* text_at) {
  if (line.size() >= 2 && (line[0] == '-' || line[0] == '*' || line[0] == '+') &&
      line[1] == ' ') {
    *text_at = 2;
    return true;
  }
  size_t d = 0;
  while (d < line.size() && std::isdigit(static_cast<unsigned char>(line[d]))) ++d;
  if (d > 0 && d < 4 && d + 1 < line.size() && (line[d] == '.' || line[d] == ')') &&
      line[d + 1] == ' ') {
    *text_at = d + 2;
    return true;
  }
  return false;
}

bool IsTableRow(const std::string& line) { return line.size() >= 2 && line[0] == '|'; }

bool IsTableSeparator(const std::string& line) {
  if (!IsTableRow(line)) return false;
  for (char c : line) {
    if (c != '|' && c != '-' && c != ':' && c != ' ') return false;
  }
  return true;
}

std::string TableRowText(const std::string& line) {
  std::string inner = line;
  if (!inner.empty() && inner.front() == '|') inner.erase(0, 1);
  if (!inner.empty() && inner.back() == '|') inner.pop_back();
  std::string out;
  size_t start = 0;
  bool first = true;
  while (start <= inner.size()) {
    const size_t bar = inner.find('|', start);
    const std::string cell =
        CleanInline(inner.substr(start, bar == std::string::npos ? std::string::npos : bar - start));
    if (!first) out += " | ";
    out += cell;
    first = false;
    if (bar == std::string::npos) break;
    start = bar + 1;
  }
  return out;
}

struct Block {
  std::string text;
  bool has_kind = false;
  OcrElementKind kind = OcrElementKind::kText;
  int level = 0;
};

}  // namespace

OcrReadingText MarkdownToReadingText(const std::string& markdown, bool soft_wrap,
                                     int frame_index) {
  std::vector<Block> blocks;
  Block para;
  bool in_table = false;
  auto flush = [&]() {
    if (!para.text.empty()) blocks.push_back(para);
    para = Block{};
    in_table = false;
  };

  size_t pos = 0;
  while (pos <= markdown.size()) {
    const size_t nl = markdown.find('\n', pos);
    const std::string raw =
        markdown.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
    pos = nl == std::string::npos ? markdown.size() + 1 : nl + 1;
    const std::string line = Trim(raw);
    if (line.empty()) {
      flush();
      continue;
    }
    size_t at = 0;
    if (const int level = HeadingLevel(line, &at)) {
      flush();
      Block h;
      h.text = CleanInline(line.substr(at));
      h.has_kind = true;
      h.kind = level == 1 ? OcrElementKind::kTitle : OcrElementKind::kSectionHeader;
      h.level = level;
      if (!h.text.empty()) blocks.push_back(h);
      continue;
    }
    if (IsTableRow(line)) {
      if (!in_table) flush();
      in_table = true;
      if (IsTableSeparator(line)) continue;
      para.has_kind = true;
      para.kind = OcrElementKind::kTable;
      if (!para.text.empty()) para.text += "\n";
      para.text += TableRowText(line);
      continue;
    }
    if (in_table) flush();
    if (ListMarker(line, &at)) {
      flush();
      Block item;
      item.text = CleanInline(line.substr(at));
      item.has_kind = true;
      item.kind = OcrElementKind::kListItem;
      if (!item.text.empty()) blocks.push_back(item);
      continue;
    }
    const std::string text = CleanInline(line);
    if (text.empty()) continue;
    if (!soft_wrap) {
      flush();
      para.text = text;
      flush();
      continue;
    }
    if (!para.text.empty()) para.text += ' ';
    para.text += text;
  }
  flush();

  OcrReadingText out;
  int cursor = 0;
  for (const Block& b : blocks) {
    if (!out.text_utf8.empty()) {
      out.text_utf8 += "\n\n";
      cursor += 2;
    }
    const int start = cursor;
    out.text_utf8 += b.text;
    cursor += Utf8ToUtf16Length(b.text);
    if (!b.has_kind) continue;
    OcrLayoutElement e;
    e.kind = b.kind;
    e.frame_index = frame_index;
    e.has_utf16 = true;
    e.utf16_start = start;
    e.utf16_end = cursor;
    if (b.kind == OcrElementKind::kTitle || b.kind == OcrElementKind::kSectionHeader) {
      e.heading_level = b.level;
    }
    out.elements.push_back(e);
  }
  return out;
}

}  // namespace ocr
}  // namespace sherpa_onnx
