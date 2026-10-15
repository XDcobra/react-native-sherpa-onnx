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

bool IsTextTag(const std::string& tag) {
  static const char* kNames[] = {
      "text",       "paragraph", "title",       "list_item",
      "caption",    "footnote",  "formula",     "code",
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

bool IsMediaTag(const std::string& tag) {
  return tag == "picture" || tag == "chart" || tag == "otsl";
}

bool TryParseLocs(const std::string& s, size_t& pos, int locs[4]) {
  size_t p = pos;
  for (int i = 0; i < 4; ++i) {
    if (p + 6 > s.size() || s.compare(p, 5, "<loc_") != 0) return false;
    size_t j = p + 5;
    if (j >= s.size() || !std::isdigit(static_cast<unsigned char>(s[j]))) return false;
    int value = 0;
    while (j < s.size() && std::isdigit(static_cast<unsigned char>(s[j]))) {
      value = value * 10 + (s[j] - '0');
      ++j;
    }
    if (j >= s.size() || s[j] != '>') return false;
    locs[i] = value;
    p = j + 1;
  }
  pos = p;
  return true;
}

struct Hit {
  size_t pos = 0;
  std::string tag;
  bool media = false;
  bool has_loc = false;
  int locs[4] = {};
  std::string inner;
};

void FindTags(const std::string& s, bool media, std::vector<Hit>& hits) {
  size_t cursor = 0;
  while (cursor < s.size()) {
    const size_t lt = s.find('<', cursor);
    if (lt == std::string::npos) break;
    if (lt + 1 >= s.size() || s[lt + 1] == '/') {
      cursor = lt + 1;
      continue;
    }
    size_t name_end = lt + 1;
    while (name_end < s.size() && s[name_end] != '>' && s[name_end] != ' ' &&
           s[name_end] != '\n' && s[name_end] != '\t') {
      ++name_end;
    }
    if (name_end >= s.size() || s[name_end] != '>') {
      cursor = lt + 1;
      continue;
    }
    const std::string tag = s.substr(lt + 1, name_end - (lt + 1));
    const bool wanted = media ? IsMediaTag(tag) : IsTextTag(tag);
    if (!wanted) {
      cursor = lt + 1;
      continue;
    }
    size_t inner_begin = name_end + 1;
    bool has_loc = false;
    int locs[4] = {};
    if (TryParseLocs(s, inner_begin, locs)) has_loc = true;
    const std::string close = "</" + tag + ">";
    const size_t end = s.find(close, inner_begin);
    if (end == std::string::npos) {
      cursor = lt + 1;
      continue;
    }
    Hit hit;
    hit.pos = lt;
    hit.tag = tag;
    hit.media = media;
    hit.has_loc = has_loc;
    for (int i = 0; i < 4; ++i) hit.locs[i] = locs[i];
    hit.inner = s.substr(inner_begin, end - inner_begin);
    hits.push_back(std::move(hit));
    cursor = end + close.size();
  }
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

std::string CollapseWhitespace(const std::string& raw) {
  std::string out;
  out.reserve(raw.size());
  bool in_run = false;
  for (char c : raw) {
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
      if (!in_run) {
        out.push_back(' ');
        in_run = true;
      }
    } else {
      in_run = false;
      out.push_back(c);
    }
  }
  return TrimAsciiWs(out);
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

OcrSpanLevel LevelFor(const std::string& tag, bool media) {
  if (media || tag == "title" || tag.rfind("section_header_level_", 0) == 0) {
    return OcrSpanLevel::kBlock;
  }
  return OcrSpanLevel::kLine;
}

std::string MarkdownFor(const std::string& tag, const std::string& text, bool media) {
  if (media) {
    if (tag == "picture") return "[picture]";
    if (tag == "chart") return "[chart]";
    return "[table]";
  }
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

struct Item {
  std::string text;
  bool in_text = false;
  std::string markdown;
  bool has_span = false;
  bool has_loc = false;
  int locs[4] = {};
  OcrSpanLevel level = OcrSpanLevel::kLine;
};

}  // namespace

DocTagsParse ParseDocTags(const std::string& doctags, int frame_w, int frame_h,
                          int frame_index) {
  if (frame_w <= 0 || frame_h <= 0) {
    throw std::invalid_argument("DocVlmDocTags: frame size must be positive");
  }

  std::vector<Hit> hits;
  FindTags(doctags, false, hits);
  FindTags(doctags, true, hits);
  std::sort(hits.begin(), hits.end(),
            [](const Hit& a, const Hit& b) { return a.pos < b.pos; });

  std::vector<Item> items;
  items.reserve(hits.size());
  for (const Hit& hit : hits) {
    if (hit.media) {
      Item item;
      item.markdown = MarkdownFor(hit.tag, "", true);
      item.has_span = hit.has_loc;
      item.has_loc = hit.has_loc;
      for (int i = 0; i < 4; ++i) item.locs[i] = hit.locs[i];
      item.level = OcrSpanLevel::kBlock;
      items.push_back(std::move(item));
      continue;
    }
    const std::string text = CleanInner(hit.inner);
    if (text.empty()) continue;
    Item item;
    item.text = text;
    item.in_text = true;
    item.markdown = MarkdownFor(hit.tag, text, false);
    item.has_span = true;
    item.has_loc = hit.has_loc;
    for (int i = 0; i < 4; ++i) item.locs[i] = hit.locs[i];
    item.level = LevelFor(hit.tag, false);
    items.push_back(std::move(item));
  }

  DocTagsParse parsed;
  if (items.empty()) {
    if (!doctags.empty()) {
      parsed.used_fallback = true;
      const std::string plain = CollapseWhitespace(StripTags(doctags));
      if (!plain.empty()) {
        parsed.text_utf8 = plain;
        parsed.markdown_utf8 = plain;
        OcrSpan span;
        span.utf16_start = 0;
        span.utf16_end = Utf8ToUtf16Length(plain);
        span.quad = MakeQuad(false, nullptr, frame_w, frame_h);
        // Greedy decode does not record logprobs.
        span.confidence = 1.f;
        span.frame_index = frame_index;
        span.level = OcrSpanLevel::kBlock;
        parsed.spans.push_back(span);
      }
    }
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
