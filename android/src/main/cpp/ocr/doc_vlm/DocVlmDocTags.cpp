#include "DocVlmDocTags.h"

#include "../OcrGeometry.h"
#include "../OcrTextUtils.h"
#include "../markup/OcrElementKind.h"
#include "../markup/OcrOtsl.h"

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
      "text",
      "paragraph",
      "title",
      "list_item",
      "caption",
      "footnote",
      "formula",
      "code",
      "page_header",
      "page_footer",
      "form",
      "key_value_region",
      "references",
      "checkbox_selected",
      "checkbox_unselected"};
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

bool IsOtslCell(const std::string& tag) { return IsOtslCellToken(tag); }

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

std::string InnerTextKeepWs(const std::vector<Tok>& toks, size_t begin, size_t end) {
  std::string raw;
  for (size_t i = begin; i < end && i < toks.size(); ++i) {
    if (toks[i].kind == TokKind::Text) raw += toks[i].text;
  }
  return TrimAsciiWs(raw);
}

bool IsCodeLanguageTag(const std::string& name) {
  return name.size() >= 3 && name.front() == '_' && name.back() == '_';
}

std::string CodeLanguageFromTag(const std::string& name) {
  return name.substr(1, name.size() - 2);
}

bool IsKnownOpenName(const std::string& name) {
  return IsTextTag(name) || IsMediaTag(name) || name == "otsl" ||
         name == "table" || name == "doctag" || IsOtslCell(name) ||
         IsCodeLanguageTag(name);
}

void ThrowIfUnknownOpen(const Tok& tok) {
  if (tok.kind != TokKind::Open) return;
  if (IsKnownOpenName(tok.name)) return;
  throw OcrCodedError(kOcrErrParseUnknownKind,
                      "unknown DocTags tag: " + tok.name);
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

OcrQuad MakeQuad(bool has_loc, const int locs[4], int frame_w, int frame_h) {
  if (!has_loc) {
    return RectToQuad(OcrPixelRect{0, 0, std::max(1, frame_w), std::max(1, frame_h)});
  }
  OcrGridRect grid;
  grid.x1 = locs[0];
  grid.y1 = locs[1];
  grid.x2 = locs[2];
  grid.y2 = locs[3];
  return RectToQuad(GridToPixels(grid, frame_w, frame_h, kOcrGridGranite));
}

OcrSpanLevel LevelFor(const std::string&) { return OcrSpanLevel::kLine; }

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

std::string PadJoinMdRow(const std::vector<std::string>& row, size_t cols) {
  std::string out = "|";
  for (size_t i = 0; i < cols; ++i) {
    out += " ";
    out += i < row.size() ? EscapeMdCell(row[i]) : "";
    out += " |";
  }
  return out;
}

struct TableCell {
  std::string text;
  bool has_loc = false;
  int locs[4] = {};
};

struct ItemSpan {
  int utf16_rel_start = 0;
  int utf16_rel_end = 0;
  bool has_loc = false;
  int locs[4] = {};
  OcrSpanLevel level = OcrSpanLevel::kLine;
};

struct Item {
  std::string tag;
  std::string text;
  std::string language;
  bool in_text = false;
  std::string markdown;
  std::vector<ItemSpan> spans;
};

void CopyLocs(int dst[4], const int src[4]) {
  for (int k = 0; k < 4; ++k) dst[k] = src[k];
}

ItemSpan MakeItemSpan(int utf16_rel_start, int utf16_rel_end, bool has_loc,
                      const int locs[4], OcrSpanLevel level) {
  ItemSpan span;
  span.utf16_rel_start = utf16_rel_start;
  span.utf16_rel_end = utf16_rel_end;
  span.has_loc = has_loc;
  CopyLocs(span.locs, locs);
  span.level = level;
  return span;
}

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
    ThrowIfUnknownOpen(t);
    ++i;
  }
  const std::string text = tag == "code" ? InnerTextKeepWs(toks, inner_begin, i)
                                        : InnerText(toks, inner_begin, i);
  std::string language;
  if (tag == "code") {
    for (size_t k = inner_begin; k < i; ++k) {
      if (toks[k].kind == TokKind::Open && IsCodeLanguageTag(toks[k].name)) {
        language = CodeLanguageFromTag(toks[k].name);
        break;
      }
    }
  }
  SkipMatchingClose(toks, i, tag);
  if (text.empty() && tag.find("checkbox_") != 0) return;
  Item item;
  item.tag = tag;
  item.text = text;
  item.language = std::move(language);
  item.in_text = !text.empty();
  item.markdown = MarkdownFor(tag, text);
  item.spans.push_back(MakeItemSpan(0, Utf8ToUtf16Length(text), has_loc, locs,
                                   LevelFor(tag)));
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
    ThrowIfUnknownOpen(t);
    ++i;
  }
  SkipMatchingClose(toks, i, tag);
  Item item;
  item.tag = tag;
  item.markdown = MarkdownFor(tag, "");
  if (has_loc) {
    item.spans.push_back(
        MakeItemSpan(0, 0, true, locs, OcrSpanLevel::kBlock));
  }
  items.push_back(std::move(item));
}

void EmitTable(const std::vector<std::vector<TableCell>>& rows,
               bool wrapper_has_loc, const int wrapper_locs[4],
               std::vector<Item>& items) {
  bool any = false;
  size_t cols = 0;
  for (const auto& row : rows) {
    cols = std::max(cols, row.size());
    for (const auto& cell : row) {
      if (!cell.text.empty()) any = true;
    }
  }
  if (!any || cols == 0) return;

  auto row_texts = [](const std::vector<TableCell>& row) {
    std::vector<std::string> texts;
    texts.reserve(row.size());
    for (const auto& cell : row) texts.push_back(cell.text);
    return texts;
  };

  std::string text;
  std::vector<ItemSpan> cell_spans;
  for (size_t r = 0; r < rows.size(); ++r) {
    if (r > 0) text += "\n";
    for (size_t c = 0; c < rows[r].size(); ++c) {
      if (c > 0) text += " | ";
      const int start = Utf8ToUtf16Length(text);
      text += rows[r][c].text;
      const int end = Utf8ToUtf16Length(text);
      if (rows[r][c].has_loc) {
        cell_spans.push_back(MakeItemSpan(start, end, true, rows[r][c].locs,
                                         OcrSpanLevel::kLine));
      }
    }
  }

  std::string markdown;
  const auto header = row_texts(rows[0]);
  markdown += PadJoinMdRow(header, cols);
  markdown += "\n|";
  for (size_t c = 0; c < cols; ++c) markdown += " --- |";
  for (size_t r = 1; r < rows.size(); ++r) {
    markdown += "\n";
    markdown += PadJoinMdRow(row_texts(rows[r]), cols);
  }

  Item item;
  item.tag = "otsl";
  item.text = text;
  item.in_text = true;
  item.markdown = markdown;
  if (!cell_spans.empty()) {
    item.spans = std::move(cell_spans);
  } else if (wrapper_has_loc) {
    item.spans.push_back(MakeItemSpan(0, Utf8ToUtf16Length(text), true,
                                     wrapper_locs, OcrSpanLevel::kLine));
  }
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
  std::vector<std::vector<TableCell>> rows;
  std::vector<TableCell> row;
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
      ThrowIfUnknownOpen(t);
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
    TableCell parsed_cell;
    parsed_cell.has_loc = TryTakeLocs(toks, i, parsed_cell.locs);
    const size_t inner_begin = i;
    while (i < toks.size()) {
      const Tok& n = toks[i];
      if (n.kind == TokKind::Open && (IsOtslCell(n.name) || n.name == "caption" ||
                                      IsStructuralOpen(n.name))) {
        break;
      }
      if (n.kind == TokKind::Close && (n.name == "otsl" || n.name == cell)) break;
      ThrowIfUnknownOpen(n);
      ++i;
    }
    parsed_cell.text = InnerText(toks, inner_begin, i);
    row.push_back(std::move(parsed_cell));
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
    ThrowIfUnknownOpen(t);
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
    if (item.in_text) {
      parsed.text_utf8 += item.text;
      ++text_seen;
      if (text_seen < text_count) parsed.text_utf8.push_back('\n');
    }
    for (const ItemSpan& spec : item.spans) {
      OcrSpan span;
      span.utf16_start = utf16_at + spec.utf16_rel_start;
      span.utf16_end = utf16_at + spec.utf16_rel_end;
      span.quad = MakeQuad(spec.has_loc, spec.locs, frame_w, frame_h);
      // Greedy decode does not record logprobs.
      span.confidence = 1.f;
      span.frame_index = frame_index;
      span.level = spec.level;
      parsed.spans.push_back(span);
    }
    if (parsed.language.empty() && !item.language.empty()) {
      parsed.language = item.language;
    }
    if (item.tag.empty()) continue;
    const auto kind = FromDocTagsTag(item.tag);
    if (!kind.ok) {
      throw OcrCodedError(kind.error_code.c_str(), kind.error_message);
    }
    OcrLayoutElement element;
    element.kind = kind.kind;
    element.frame_index = frame_index;
    element.heading_level = kind.level;
    element.checked = kind.checked;
    if (!item.spans.empty() && item.spans[0].has_loc) {
      element.has_quad = true;
      element.quad = MakeQuad(true, item.spans[0].locs, frame_w, frame_h);
    }
    if (item.in_text) {
      element.has_utf16 = true;
      element.utf16_start = utf16_at;
      element.utf16_end = utf16_at + Utf8ToUtf16Length(item.text);
    }
    parsed.elements.push_back(element);
  }
  return parsed;
}

void AdoptBareProse(DocTagsParse& parsed, const std::string& raw) {
  if (!parsed.elements.empty() || !parsed.text_utf8.empty()) return;
  std::string plain = raw;
  const char* eos = "<|end_of_text|>";
  const auto eos_at = plain.find(eos);
  if (eos_at != std::string::npos) plain.resize(eos_at);
  while (!plain.empty() &&
         (plain.back() == ' ' || plain.back() == '\t' || plain.back() == '\n' ||
          plain.back() == '\r')) {
    plain.pop_back();
  }
  size_t i = 0;
  while (i < plain.size() &&
         (plain[i] == ' ' || plain[i] == '\t' || plain[i] == '\n' ||
          plain[i] == '\r')) {
    ++i;
  }
  if (i > 0) plain.erase(0, i);
  if (plain.empty() || plain.find('<') != std::string::npos) return;
  parsed.text_utf8 = plain;
  parsed.markdown_utf8 = plain;
}

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
