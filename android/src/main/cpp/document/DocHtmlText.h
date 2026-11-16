#pragma once

#include "DocTypes.h"
#include "DocUtf16.h"

#include "../textbuffer/TxtStructure.h"

#include <cstdint>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace document {

enum class HtmlBlockKind { Paragraph, Heading, Image, Separator };

/** One reading-order item of an XHTML document (reader structure v1). */
struct HtmlBlock {
  HtmlBlockKind kind = HtmlBlockKind::Paragraph;
  int level = 0;  // 1–6 for headings
  std::string text;  // text blocks only
  std::string image_src;  // images: src / href / xlink:href as written
  std::string alt;
  bool has_alt = false;
  /** > 0: this heading is an entry of the book's contents at that level (FB2 titles). */
  int toc_level = 0;
  /** Inline italic / bold over `text` (UTF-16, relative to the block); text blocks only. */
  std::vector<TxtStyleRun> styles;
};

struct HtmlExtract {
  std::string text;  // text blocks joined with \n\n
  std::vector<std::string> blocks;  // text of each text block (= items with text)
  /** Text, image and separator blocks in reading order. */
  std::vector<HtmlBlock> items;
  /** Set when lexbor was not linked (`ERR_DOC_LEXBOR_DISABLED`). */
  std::string error_code;
  std::string error_message;
};

/**
 * lexbor HTML5 parse → reading blocks. Skips script/style/head/template/rt/rp.
 *
 * Structure v1 rules: p/h1–h6/li/blockquote/pre/td form blocks (heading level
 * from h1–h6); hr is a separator; img and svg <image> are image blocks, emitted
 * after the block they sit in. Whitespace inside text collapses to one space,
 * <br> becomes \n, pre keeps its text unchanged.
 */
HtmlExtract ExtractHtmlText(const uint8_t* data, size_t size);

/** First img/src or svg image href in document order. Empty if none. */
std::string FirstImageHref(const uint8_t* data, size_t size);

/** First Kindle `recindex` on an img (1-based resource id as decimal string). */
std::string FirstImageRecindex(const uint8_t* data, size_t size);

/**
 * Style runs of a final block string from one flag byte per UTF-8 byte
 * (`flags.size() == text.size()`; a code point takes the flags of its lead
 * byte). Adjacent units with the same flags merge; unstyled units make no run.
 * Returns no runs when the sizes differ.
 */
inline std::vector<TxtStyleRun> StyleRunsFromByteFlags(const std::string& text,
                                                       const std::vector<uint8_t>& flags) {
  std::vector<TxtStyleRun> runs;
  if (flags.size() != text.size()) return runs;
  int u16 = 0;
  for (size_t i = 0; i < text.size();) {
    const unsigned char c = static_cast<unsigned char>(text[i]);
    size_t bytes = 1;
    int units = 1;
    if ((c >> 5) == 0x6) {
      bytes = 2;
    } else if ((c >> 4) == 0xE) {
      bytes = 3;
    } else if ((c >> 3) == 0x1E) {
      bytes = 4;
      units = 2;
    }
    const uint32_t f = flags[i];
    if (f != 0) {
      if (!runs.empty() && runs.back().end == u16 && runs.back().flags == f) {
        runs.back().end += units;
      } else {
        runs.push_back({u16, u16 + units, f});
      }
    }
    u16 += units;
    i += bytes;
  }
  return runs;
}

inline bool HtmlIsImageOnly(const HtmlExtract& e) { return IsWsOnly(e.text); }

}  // namespace document
}  // namespace sherpa_onnx
