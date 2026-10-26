#include "DocVlmDocTags.h"

#include "../OcrTextUtils.h"

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {
namespace {

enum class TokKind { Open, Close, Loc, Text };

struct Tok {
  TokKind kind = TokKind::Text;
  std::string name;
  int loc = 0;
  std::string text;
};

bool IsNameChar(char c) {
  return std::isalnum(static_cast<unsigned char>(c)) != 0 || c == '_';
}

bool IsTextTag(const std::string& tag) {
  static const char* kNames[] = {
      "text",        "paragraph", "title",      "list_item",
      "caption",     "footnote",  "formula",    "code",
      "page_header", "page_footer"};
  for (const char* name : kNames) {
    if (tag == name) return true;
  }
  constexpr char kPrefix[] = "section_header_level_";
  constexpr size_t kPrefixLen = sizeof(kPrefix) - 1;
  if (tag.size() == kPrefixLen + 1 && tag.compare(0, kPrefixLen, kPrefix) == 0) {
    const char d = tag.back();
    return d >= '1' && d <= '6';
  }
  return false;
}

bool IsMediaTag(const std::string& tag) { return tag == "picture" || tag == "chart"; }

bool IsOtslCell(const std::string& tag) {
  return tag == "fcel" || tag == "ched" || tag == "rhed" || tag == "ecel" ||
         tag == "lcel" || tag == "ucel" || tag == "xcel" || tag == "nl" || tag == "srow";
}

bool IsContentCell(const std::string& tag) {
  return tag == "fcel" || tag == "ched" || tag == "rhed";
}

bool IsStructuralOpen(const std::string& tag) {
  return IsTextTag(tag) || IsMediaTag(tag) || tag == "otsl";
}

std::vector<Tok> Lex(const std::string& s) {
  std::vector<Tok> out;
  std::string pending;
  auto flush = [&]() {
    if (pending.empty()) return;
    Tok tok;
    tok.kind = TokKind::Text;
    tok.text = pending;
    out.push_back(std::move(tok));
    pending.clear();
  };

  for (size_t i = 0; i < s.size();) {
    if (s[i] != '<') {
      pending.push_back(s[i]);
      ++i;
      continue;
    }
    const size_t gt = s.find('>', i + 1);
    if (gt == std::string::npos) {
      pending.push_back(s[i]);
      ++i;
      continue;
    }
    const bool closing = (i + 1 < s.size() && s[i + 1] == '/');
    size_t name_begin = i + 1 + (closing ? 1 : 0);
    size_t name_end = name_begin;
    while (name_end < gt && IsNameChar(s[name_end])) ++name_end;
    if (name_end == name_begin || name_end != gt) {
      pending.push_back(s[i]);
      ++i;
      continue;
    }
    flush();
    const std::string name = s.substr(name_begin, name_end - name_begin);
    Tok tok;
    if (closing) {
      tok.kind = TokKind::Close;
      tok.name = name;
    } else if (name.size() > 4 && name.compare(0, 4, "loc_") == 0) {
      int value = 0;
      bool digits = false;
      for (size_t k = 4; k < name.size(); ++k) {
        if (!std::isdigit(static_cast<unsigned char>(name[k]))) {
          digits = false;
          break;
        }
        digits = true;
        value = value * 10 + (name[k] - '0');
      }
      if (digits) {
        tok.kind = TokKind::Loc;
        tok.name = name;
        tok.loc = value;
      } else {
        tok.kind = TokKind::Open;
        tok.name = name;
      }
    } else {
      tok.kind = TokKind::Open;
      tok.name = name;
    }
    out.push_back(std::move(tok));
    i = gt + 1;
  }
  flush();
  return out;
}

std::string StripTags(const std::string& raw) {
  std::string out;
  out.reserve(raw.size());
  for (size_t i = 0; i < raw.size();) {
    if (raw[i] == '<') {
      const size_t gt = raw.find('>', i + 1);
      if (gt == std::string::npos) {
        out.push_back(raw[i]);
        ++i;
      } else {
        i = gt + 1;
      }
    } else {
      out.push_back(raw[i]);
      ++i;
    }
  }
  return out;
}

std::string CollapseSpaceTab(const std::string& raw) {
  std::string out;
  out.reserve(raw.size());
  bool in_run = false;
  for (char c : raw) {
    if (c == ' ' || c == '\t') {
      if (!in_run) {
        out.push_back(' ');
        in_run = true;
      }
    } else {
      in_run = false;
      out.push_back(c);
    }
  }
  return out;
}

std::string TrimAsciiWs(const std::string& raw) {
  size_t begin = 0;
  while (begin < raw.size()) {
    const char c = raw[begin];
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
    ++begin;
  }
  size_t end = raw.size();
  while (end > begin) {
    const char c = raw[end - 1];
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
    --end;
  }
  return raw.substr(begin, end - begin);
}

std::string CleanInner(const std::string& raw) {
  return TrimAsciiWs(CollapseSpaceTab(StripTags(raw)));
}

std::string InnerText(const std::vector<Tok>& toks, size_t begin, size_t end) {
  std::string raw;
  for (size_t i = begin; i < end && i < toks.size(); ++i) {
    if (toks[i].kind == TokKind::Text) raw += toks[i].text;
  }
  return CleanInner(raw);
}

bool TryTakeLocs(const std::vector<Tok>& toks, size_t& i, int locs[4]) {
  if (i + 4 > toks.size()) return false;
  for (int k = 0; k < 4; ++k) {
    if (toks[i + static_cast<size_t>(k)].kind != TokKind::Loc) return false;
  }
  for (int k = 0; k < 4; ++k) {
    locs[k] = toks[i + static_cast<size_t>(k)].loc;
  }
  i += 4;
  return true;
}

int ClampLoc(int loc) {
  if (loc < 0) return 0;
  if (loc > 499) return 499;
  return loc;
}

float LocToPx(int loc, int extent) {
  return static_cast<float>(ClampLoc(loc)) / 500.f * static_cast<float>(extent);
}

OcrQuad MakeQuad(bool has_loc, const int locs[4], int frame_w, int frame_h) {
  OcrQuad quad;
  float x0 = 0.f;
  float y0 = 0.f;
  float x1 = static_cast<float>(frame_w);
  float y1 = static_cast<float>(frame_h);
  if (has_loc) {
    x0 = LocToPx(locs[0], frame_w);
    y0 = LocToPx(locs[1], frame_h);
    x1 = LocToPx(locs[2], frame_w);
    y1 = LocToPx(locs[3], frame_h);
    if (x1 < x0) std::swap(x0, x1);
    if (y1 < y0) std::swap(y0, y1);
  }
  quad.xy[0] = x0;
  quad.xy[1] = y0;
  quad.xy[2] = x1;
  quad.xy[3] = y0;
  quad.xy[4] = x1;
  quad.xy[5] = y1;
  quad.xy[6] = x0;
  quad.xy[7] = y1;
  return quad;
}

OcrSpanLevel LevelFor(const std::string& tag) {
  if (tag == "title" || tag.rfind("section_header_level_", 0) == 0) {
    return OcrSpanLevel::kBlock;
  }
  return OcrSpanLevel::kLine;
}

std::string MarkdownFor(const std::string& tag, const std::string& text) {
  if (tag == "picture") return "[picture]";
  if (tag == "chart") return "[chart]";
  if (tag == "title") return "# " + text;
  if (tag.rfind("section_header_level_", 0) == 0) {
    const int level = tag.back() - '0';
    const int hashes = std::min(6, level + 1);
    return std::string(static_cast<size_t>(hashes), '#') + " " + text;
  }
  if (tag == "list_item") return "- " + text;
  if (tag == "formula") {
    if (text.find("$$") == std::string::npos) return "$$" + text + "$$";
    return text;
  }
  if (tag == "code") return "```\n" + text + "\n```";
  return text;
}

std::string EscapeMdCell(const std::string& cell) {
  std::string out;
  out.reserve(cell.size());
  for (char c : cell) {
    if (c == '|') out += "\\|";
    else if (c == '\n' || c == '\r') out.push_back(' ');
    else out.push_back(c);
  }
  return out;
}

std::string JoinRow(const std::vector<std::string>& row, const char* sep) {
  std::string out;
  for (size_t i = 0; i < row.size(); ++i) {
    if (i > 0) out += sep;
    out += row[i];
  }
  return out;
}

std::string PadJoinMdRow(const std::vector<std::string>& row, size_t cols) {
  std::string out = "|";
  for (size_t i = 0; i < cols; ++i) {
    out += " ";
    out += i < row.size() ? EscapeMdCell(row[i]) : "";
    out += " |";
  }
  return out;
}

struct Item {
  std::string text;
  bool in_text = false;
  std::string markdown;
  bool has_span = false;
  bool has_loc = false;
  int locs[4] = {};
  OcrSpanLevel level = OcrSpanLevel::kLine;
};

void SkipMatchingClose(const std::vector<Tok>& toks, size_t& i, const std::string& name) {
  if (i < toks.size() && toks[i].kind == TokKind::Close && toks[i].name == name) {
    ++i;
  }
}

void ParseTextLike(const std::vector<Tok>& toks, size_t& i, std::vector<Item>& items) {
  const std::string tag = toks[i].name;
  ++i;
  int locs[4] = {};
  const bool has_loc = TryTakeLocs(toks, i, locs);
  const size_t inner_begin = i;
  while (i < toks.size()) {
    const Tok& t = toks[i];
    if (t.kind == TokKind::Close && t.name == tag) break;
    if (t.kind == TokKind::Open && IsStructuralOpen(t.name) && t.name != tag) break;
    ++i;
  }
  const std::string text = InnerText(toks, inner_begin, i);
  SkipMatchingClose(toks, i, tag);
  if (text.empty()) return;
  Item item;
  item.text = text;
  item.in_text = true;
  item.markdown = MarkdownFor(tag, text);
  item.has_span = true;
  item.has_loc = has_loc;
  for (int k = 0; k < 4; ++k) item.locs[k] = locs[k];
  item.level = LevelFor(tag);
  items.push_back(std::move(item));
}

void ParseMedia(const std::vector<Tok>& toks, size_t& i, std::vector<Item>& items) {
  const std::string tag = toks[i].name;
  ++i;
  int locs[4] = {};
  const bool has_loc = TryTakeLocs(toks, i, locs);
  while (i < toks.size()) {
    const Tok& t = toks[i];
    if (t.kind == TokKind::Close && t.name == tag) break;
    if (t.kind == TokKind::Open && IsStructuralOpen(t.name) && t.name != tag) break;
    ++i;
  }
  SkipMatchingClose(toks, i, tag);
  Item item;
  item.markdown = MarkdownFor(tag, "");
  item.has_span = has_loc;
  item.has_loc = has_loc;
  for (int k = 0; k < 4; ++k) item.locs[k] = locs[k];
  item.level = OcrSpanLevel::kBlock;
  items.push_back(std::move(item));
}

void EmitTable(const std::vector<std::vector<std::string>>& rows, bool has_loc,
               const int locs[4], std::vector<Item>& items) {
  bool any = false;
  size_t cols = 0;
  for (const auto& row : rows) {
    cols = std::max(cols, row.size());
    for (const auto& cell : row) {
      if (!cell.empty()) any = true;
    }
  }
  if (!any || cols == 0) return;

  std::string text;
  std::string markdown;
  const auto& header = rows[0];
  markdown += PadJoinMdRow(header, cols);
  markdown += "\n|";
  for (size_t c = 0; c < cols; ++c) markdown += " --- |";
  text += JoinRow(header, " | ");
  for (size_t r = 1; r < rows.size(); ++r) {
    text += "\n";
    text += JoinRow(rows[r], " | ");
    markdown += "\n";
    markdown += PadJoinMdRow(rows[r], cols);
  }

  Item item;
  item.text = text;
  item.in_text = true;
  item.markdown = markdown;
  item.has_span = has_loc;
  item.has_loc = has_loc;
  for (int k = 0; k < 4; ++k) item.locs[k] = locs[k];
  item.level = OcrSpanLevel::kBlock;
  items.push_back(std::move(item));
}

void ParseOtsl(const std::vector<Tok>& toks, size_t& i, std::vector<Item>& items) {
  int locs[4] = {};
  bool has_loc = false;
  if (i < toks.size() && toks[i].kind == TokKind::Open && toks[i].name == "otsl") {
    ++i;
    has_loc = TryTakeLocs(toks, i, locs);
  }

  std::vector<Item> captions;
  std::vector<std::vector<std::string>> rows;
  std::vector<std::string> row;
  auto flush_row = [&]() {
    if (row.empty()) return;
    rows.push_back(row);
    row.clear();
  };

  while (i < toks.size()) {
    const Tok& t = toks[i];
    if (t.kind == TokKind::Close && t.name == "otsl") {
      ++i;
      break;
    }
    if (t.kind == TokKind::Open && t.name == "caption") {
      ParseTextLike(toks, i, captions);
      continue;
    }
    if (t.kind == TokKind::Open && IsStructuralOpen(t.name)) {
      break;
    }
    if (t.kind != TokKind::Open || !IsOtslCell(t.name)) {
      ++i;
      continue;
    }
    const std::string cell = t.name;
    ++i;
    if (cell == "nl" || cell == "srow") {
      flush_row();
      continue;
    }
    if (cell == "ecel") {
      row.emplace_back();
      continue;
    }
    if (!IsContentCell(cell)) {
      continue;
    }
    const size_t inner_begin = i;
    while (i < toks.size()) {
      const Tok& n = toks[i];
      if (n.kind == TokKind::Open && (IsOtslCell(n.name) || n.name == "caption" ||
                                      IsStructuralOpen(n.name))) {
        break;
      }
      if (n.kind == TokKind::Close && (n.name == "otsl" || n.name == cell)) break;
      ++i;
    }
    row.push_back(InnerText(toks, inner_begin, i));
    if (i < toks.size() && toks[i].kind == TokKind::Close && toks[i].name == cell) {
      ++i;
    }
  }
  flush_row();
  items.insert(items.end(), captions.begin(), captions.end());
  EmitTable(rows, has_loc, locs, items);
}

void Walk(const std::vector<Tok>& toks, std::vector<Item>& items) {
  size_t i = 0;
  while (i < toks.size()) {
    const Tok& t = toks[i];
    if (t.kind == TokKind::Open && (t.name == "doctag" || t.name == "table")) {
      ++i;
      continue;
    }
    if (t.kind == TokKind::Close && (t.name == "doctag" || t.name == "table")) {
      ++i;
      continue;
    }
    if (t.kind == TokKind::Open && IsTextTag(t.name)) {
      ParseTextLike(toks, i, items);
      continue;
    }
    if (t.kind == TokKind::Open && IsMediaTag(t.name)) {
      ParseMedia(toks, i, items);
      continue;
    }
    if (t.kind == TokKind::Open && (t.name == "otsl" || IsOtslCell(t.name))) {
      ParseOtsl(toks, i, items);
      continue;
    }
    ++i;
  }
}

}  // namespace

DocTagsParse ParseDocTags(const std::string& doctags, int frame_w, int frame_h,
                          int frame_index) {
  if (frame_w <= 0 || frame_h <= 0) {
    throw std::invalid_argument("DocVlmDocTags: frame size must be positive");
  }

  const std::vector<Tok> toks = Lex(doctags);
  std::vector<Item> items;
  Walk(toks, items);

  DocTagsParse parsed;
  if (items.empty()) {
    return parsed;
  }

  int text_count = 0;
  for (const Item& item : items) {
    if (item.in_text) ++text_count;
  }
  int text_seen = 0;
  for (const Item& item : items) {
    if (!parsed.markdown_utf8.empty() && !item.markdown.empty()) {
      parsed.markdown_utf8.push_back('\n');
    }
    parsed.markdown_utf8 += item.markdown;

    const int utf16_at = Utf8ToUtf16Length(parsed.text_utf8);
    int utf16_end = utf16_at;
    if (item.in_text) {
      parsed.text_utf8 += item.text;
      utf16_end = Utf8ToUtf16Length(parsed.text_utf8);
      ++text_seen;
      if (text_seen < text_count) parsed.text_utf8.push_back('\n');
    }
    if (!item.has_span) continue;
    OcrSpan span;
    span.utf16_start = utf16_at;
    span.utf16_end = utf16_end;
    span.quad = MakeQuad(item.has_loc, item.locs, frame_w, frame_h);
    // Greedy decode does not record logprobs.
    span.confidence = 1.f;
    span.frame_index = frame_index;
    span.level = item.level;
    parsed.spans.push_back(span);
  }
  return parsed;
}

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
