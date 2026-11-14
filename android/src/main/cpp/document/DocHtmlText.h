#pragma once

#include "DocTypes.h"
#include "DocUtf16.h"

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

inline bool HtmlIsImageOnly(const HtmlExtract& e) { return IsWsOnly(e.text); }

}  // namespace document
}  // namespace sherpa_onnx
