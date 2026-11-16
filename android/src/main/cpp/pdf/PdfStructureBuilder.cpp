#include "PdfStructureBuilder.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <map>
#include <set>
#include <utility>

namespace sherpa_onnx {
namespace pdf {

namespace {

int Utf16Len(const std::string& s) {
  int n = 0;
  for (size_t i = 0; i < s.size();) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    size_t len = 1;
    int units = 1;
    if (c >= 0xF0) {
      len = 4;
      units = 2;
    } else if (c >= 0xE0) {
      len = 3;
    } else if (c >= 0xC0) {
      len = 2;
    }
    i += len;
    n += units;
  }
  return n;
}

uint32_t DecodeAt(const std::string& s, size_t i) {
  const unsigned char c = static_cast<unsigned char>(s[i]);
  if (c < 0x80) return c;
  if (c >= 0xF0 && i + 3 < s.size()) {
    return ((c & 0x07u) << 18) | ((s[i + 1] & 0x3Fu) << 12) | ((s[i + 2] & 0x3Fu) << 6) |
           (s[i + 3] & 0x3Fu);
  }
  if (c >= 0xE0 && i + 2 < s.size()) {
    return ((c & 0x0Fu) << 12) | ((s[i + 1] & 0x3Fu) << 6) | (s[i + 2] & 0x3Fu);
  }
  if (c >= 0xC0 && i + 1 < s.size()) return ((c & 0x1Fu) << 6) | (s[i + 1] & 0x3Fu);
  return c;
}

uint32_t FirstCp(const std::string& s) { return s.empty() ? 0 : DecodeAt(s, 0); }

uint32_t LastCp(const std::string& s) {
  if (s.empty()) return 0;
  size_t i = s.size() - 1;
  while (i > 0 && (static_cast<unsigned char>(s[i]) & 0xC0u) == 0x80u) --i;
  return DecodeAt(s, i);
}

bool IsCjk(uint32_t cp) {
  return (cp >= 0x3000 && cp <= 0x30FF) || (cp >= 0x3400 && cp <= 0x9FFF) ||
         (cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0xF900 && cp <= 0xFAFF) ||
         (cp >= 0xFF00 && cp <= 0xFFEF) || (cp >= 0x20000 && cp <= 0x2FFFF);
}

bool IsHyphen(uint32_t cp) { return cp == '-' || cp == 0x2010 || cp == 0x00AD; }

bool IsLowerAscii(uint32_t cp) { return cp >= 'a' && cp <= 'z'; }

std::string Trim(const std::string& s) {
  size_t a = 0;
  while (a < s.size() && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
  size_t b = s.size();
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
  return s.substr(a, b - a);
}

/** Key for repeated headers / footers: digits and roman numerals ignored. */
std::string FurnitureKey(const std::string& text) {
  std::string out;
  for (char c : Trim(text)) {
    if (std::isdigit(static_cast<unsigned char>(c))) {
      if (out.empty() || out.back() != '#') out.push_back('#');
    } else {
      out.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    }
  }
  return out;
}

/** "12", "xiv", "- 3 -", "Page 4", "4 / 20". */
bool LooksLikePageNumber(const std::string& text) {
  const std::string t = Trim(text);
  if (t.empty() || t.size() > 16) return false;
  bool digit = false;
  bool roman_only = true;
  for (char c : t) {
    const char l = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (std::isdigit(static_cast<unsigned char>(c))) digit = true;
    if (std::string("ivxlcdm").find(l) == std::string::npos) roman_only = false;
  }
  if (roman_only) return true;
  if (!digit) return false;
  for (char c : t) {
    const char l = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    const bool ok = std::isdigit(static_cast<unsigned char>(c)) || c == ' ' || c == '-' ||
                    c == '/' || c == '.' || std::string("pageof").find(l) != std::string::npos;
    if (!ok) return false;
  }
  return true;
}

float WeightedMedianSize(const std::vector<PdfPageText>& pages) {
  std::vector<std::pair<float, size_t>> sizes;
  size_t total = 0;
  for (const auto& p : pages) {
    for (const auto& l : p.lines) {
      if (l.font_size <= 0) continue;
      sizes.push_back({l.font_size, l.text.size()});
      total += l.text.size();
    }
  }
  if (sizes.empty()) return 0;
  std::sort(sizes.begin(), sizes.end());
  size_t acc = 0;
  for (const auto& s : sizes) {
    acc += s.second;
    if (acc * 2 >= total) return s.first;
  }
  return sizes.back().first;
}

float FirstWordWidth(const PdfLine& l) {
  if (l.first_word_width > 0) return l.first_word_width;
  const std::string t = Trim(l.text);
  if (t.empty()) return 0;
  const size_t sp = t.find(' ');
  const size_t n = sp == std::string::npos ? t.size() : sp;
  return (l.x1 - l.x0) * static_cast<float>(n) / static_cast<float>(t.size());
}

struct Item {
  const PdfLine* line = nullptr;
  bool furniture = false;
  bool heading = false;
};

}  // namespace

PdfReadingText BuildPdfReadingText(const std::vector<PdfPageText>& pages,
                                   const PdfDocInfo& info) {
  PdfReadingText out;
  auto st = std::make_shared<TxtStructure>();
  st->format = "pdf";
  st->version = kPdfStructureVersion;
  st->title = info.title;
  st->creator = info.author;
  st->language = info.language;

  const float body = WeightedMedianSize(pages);

  // Repeated lines in the top / bottom 10 % (running headers, footers).
  std::map<std::string, std::set<int>> band_keys;
  auto in_band = [](const PdfPageText& p, const PdfLine& l) {
    return p.height > 0 && (l.y1 <= 0.1f * p.height || l.y0 >= 0.9f * p.height);
  };
  for (const auto& p : pages) {
    for (const auto& l : p.lines) {
      if (in_band(p, l)) band_keys[FurnitureKey(l.text)].insert(p.page_number);
    }
  }

  // Heading sizes → levels 1..3 by rank (larger first).
  auto is_heading_size = [&](float size) { return body > 0 && size >= body * 1.15f; };
  std::set<float, std::greater<float>> heading_sizes;
  for (const auto& p : pages) {
    for (const auto& l : p.lines) {
      if (is_heading_size(l.font_size) && l.text.size() <= 150 && !in_band(p, l)) {
        heading_sizes.insert(std::round(l.font_size * 2) / 2);
      }
    }
  }
  // Sizes within 15 % of a group's largest size share its level.
  std::vector<float> level_tops;
  for (float s : heading_sizes) {
    if (level_tops.empty() || s * 1.15f < level_tops.back()) level_tops.push_back(s);
  }
  auto level_of = [&](float size) {
    const float key = std::round(size * 2) / 2;
    int level = 1;
    for (float top : level_tops) {
      if (key * 1.15f < top) ++level;  // a larger group above
    }
    return std::min(3, level);
  };

  int cursor = 0;
  struct HeadingRef {
    int section;
    int block;
    int level;
    std::string text;
  };
  std::vector<HeadingRef> headings;

  for (const auto& page : pages) {
    TxtStructSection sec;
    sec.sectionIndex = page.page_number - 1;
    sec.href = "page:" + std::to_string(page.page_number);
    sec.kind = "page";
    sec.label = page.label;
    sec.firstBlock = static_cast<int>(st->blocks.size());
    sec.utf16Start = sec.utf16End = cursor;

    auto push_block = [&](TxtStructBlock b) {
      b.sectionIndex = sec.sectionIndex;
      b.blockIndex = static_cast<int>(st->blocks.size()) - sec.firstBlock;
      st->blocks.push_back(std::move(b));
    };

    TxtStructBlock page_block;
    page_block.type = TxtBlockType::Page;
    page_block.imageHref = sec.href;
    page_block.frameIndex = page.page_number - 1;
    page_block.utf16Start = page_block.utf16End = cursor;
    push_block(page_block);

    std::vector<Item> items;
    for (const auto& l : page.lines) {
      if (Trim(l.text).empty()) continue;
      Item it;
      it.line = &l;
      if (in_band(page, l)) {
        const auto& seen = band_keys[FurnitureKey(l.text)];
        it.furniture = (seen.size() >= 2 && pages.size() >= 2) || LooksLikePageNumber(l.text);
      }
      it.heading = !it.furniture && is_heading_size(l.font_size) && l.text.size() <= 150;
      items.push_back(it);
    }

    // Column edge per line: the widest extent of body lines it overlaps.
    auto column_right = [&](const PdfLine& a) {
      float right = a.x1;
      for (const Item& it : items) {
        if (it.furniture || it.heading) continue;
        const PdfLine& l = *it.line;
        if (std::min(a.x1, l.x1) > std::max(a.x0, l.x0)) right = std::max(right, l.x1);
      }
      return right;
    };

    // Group into blocks.
    std::vector<std::vector<const Item*>> groups;
    for (size_t k = 0; k < items.size(); ++k) {
      const Item& b = items[k];
      bool join = false;
      if (k > 0) {
        const Item& a = items[k - 1];
        const PdfLine& la = *a.line;
        const PdfLine& lb = *b.line;
        const float size = std::max(1.f, std::max(la.font_size, la.y1 - la.y0));
        const float gap = lb.y0 - la.y1;
        const bool overlap = std::min(la.x1, lb.x1) > std::max(la.x0, lb.x0);
        const bool same_kind = a.furniture == b.furniture && a.heading == b.heading &&
                               std::fabs(la.font_size - lb.font_size) <= 0.6f;
        if (same_kind && !a.furniture && gap >= -0.5f * size && gap <= 0.8f * size && overlap) {
          if (a.heading) {
            join = true;  // a heading wrapped over several lines
          } else {
            const bool hyphenated = IsHyphen(LastCp(Trim(la.text))) &&
                                    IsLowerAscii(FirstCp(Trim(lb.text)));
            const bool indent = (lb.x0 - la.x0) > size && lb.x1 >= la.x1 - 2 * size;
            // The previous line ended early: the next line's first word (plus
            // a space and some slack) would have fit after it.
            const bool short_prev =
                (column_right(la) - la.x1) > FirstWordWidth(lb) + 0.6f * size;
            join = hyphenated || (!indent && !short_prev);
          }
        }
      }
      if (join) {
        groups.back().push_back(&b);
      } else {
        groups.push_back({&b});
      }
    }

    bool page_has_text = false;
    bool page_has_block = false;
    for (const auto& g : groups) {
      std::string text;
      std::vector<PdfTextSpan> spans;
      for (size_t j = 0; j < g.size(); ++j) {
        std::string piece = Trim(g[j]->line->text);
        if (j > 0) {
          const uint32_t last = LastCp(text);
          const uint32_t first = FirstCp(piece);
          if (IsHyphen(last) && IsLowerAscii(first) && !g[j]->heading) {
            // "exam-" + "ple" → "example".
            const size_t cut = text.size() - (last == '-' ? 1 : (last == 0x2010 ? 3 : 2));
            const int removed = Utf16Len(text.substr(cut));
            text.erase(cut);
            if (!spans.empty()) spans.back().utf16_end -= removed;
          } else if (!(IsCjk(last) || IsCjk(first))) {
            text.push_back(' ');
          }
        }
        PdfTextSpan s;
        s.utf16_start = Utf16Len(text);
        text += piece;
        s.utf16_end = Utf16Len(text);
        s.level = "line";
        s.page_number = page.page_number;
        s.page_width = page.width;
        s.page_height = page.height;
        s.frame_index = page.page_number - 1;
        const PdfLine& l = *g[j]->line;
        const float q[8] = {l.x0, l.y0, l.x1, l.y0, l.x1, l.y1, l.x0, l.y1};
        for (int k = 0; k < 8; ++k) s.quad[k] = q[k];
        spans.push_back(s);
      }
      if (text.empty()) continue;
      if (!out.text.empty()) {
        out.text += "\n\n";
        cursor += 2;
      }
      const int start = cursor;
      out.text += text;
      cursor += Utf16Len(text);
      for (auto& s : spans) {
        s.utf16_start += start;
        s.utf16_end += start;
        out.spans.push_back(s);
      }

      TxtStructBlock b;
      b.type = g[0]->heading ? TxtBlockType::Heading : TxtBlockType::Paragraph;
      b.headingLevel = g[0]->heading ? level_of(g[0]->line->font_size) : 0;
      if (g[0]->furniture) b.flags |= kTxtBlockFurniture;
      b.utf16Start = start;
      b.utf16End = cursor;
      float x0 = 1e9f, y0 = 1e9f, x1 = -1e9f, y1 = -1e9f;
      for (const Item* it : g) {
        x0 = std::min(x0, it->line->x0);
        y0 = std::min(y0, it->line->y0);
        x1 = std::max(x1, it->line->x1);
        y1 = std::max(y1, it->line->y1);
      }
      if (page.width > 0 && page.height > 0) {
        b.hasRect = true;
        b.rect[0] = std::max(0.f, x0 / page.width);
        b.rect[1] = std::max(0.f, y0 / page.height);
        b.rect[2] = std::min(1.f, (x1 - x0) / page.width);
        b.rect[3] = std::min(1.f, (y1 - y0) / page.height);
      }
      if (b.type == TxtBlockType::Heading) {
        headings.push_back({sec.sectionIndex,
                            static_cast<int>(st->blocks.size()) - sec.firstBlock,
                            b.headingLevel, text});
        if (sec.title.empty()) {
          sec.title = text;
          sec.titleSource = "heading";
        }
      }
      // The section's range covers all its text (furniture too); a page
      // counts as having text only with body text.
      if (!page_has_block) sec.utf16Start = start;
      sec.utf16End = cursor;
      page_has_block = true;
      if (!g[0]->furniture) page_has_text = true;
      push_block(std::move(b));
    }
    if (page_has_text) ++out.pages_with_text;
    sec.blockCount = static_cast<int>(st->blocks.size()) - sec.firstBlock;
    st->sections.push_back(std::move(sec));
  }

  // Contents: the outline, pointed at the matching heading of its page when
  // there is one; else the detected headings.
  std::map<int, int> page_pos;  // section index → position in st->sections
  for (size_t i = 0; i < st->sections.size(); ++i) {
    page_pos[st->sections[i].sectionIndex] = static_cast<int>(i);
  }
  if (!info.outline.empty()) {
    for (const auto& e : info.outline) {
      if (page_pos.count(e.page_number - 1) == 0) continue;  // page not extracted
      TxtTocEntry t;
      t.title = e.title;
      t.level = std::max(1, e.level);
      t.sectionIndex = e.page_number - 1;
      t.blockIndex = 0;  // the page
      std::string want = e.title;
      std::transform(want.begin(), want.end(), want.begin(),
                     [](unsigned char c) { return std::tolower(c); });
      for (const auto& h : headings) {
        if (h.section != t.sectionIndex) continue;
        std::string got = h.text;
        std::transform(got.begin(), got.end(), got.begin(),
                       [](unsigned char c) { return std::tolower(c); });
        if (got.find(want) != std::string::npos || want.find(got) != std::string::npos) {
          t.blockIndex = h.block;
          break;
        }
      }
      // Like EPUB: a section's title comes from the contents first.
      TxtStructSection& sec = st->sections[static_cast<size_t>(page_pos[t.sectionIndex])];
      if (sec.titleSource != "toc") {
        sec.title = t.title;
        sec.titleSource = "toc";
      }
      st->toc.push_back(std::move(t));
    }
  } else {
    for (const auto& h : headings) {
      TxtTocEntry t;
      t.title = h.text;
      t.level = h.level;
      t.sectionIndex = h.section;
      t.blockIndex = h.block;
      st->toc.push_back(std::move(t));
    }
  }
  out.structure = std::move(st);
  return out;
}

}  // namespace pdf
}  // namespace sherpa_onnx
