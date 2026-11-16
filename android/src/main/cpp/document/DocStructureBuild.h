#pragma once

#include "DocHtmlText.h"
#include "DocTypes.h"

#include "../textbuffer/TxtStructure.h"

#include <functional>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace document {

/**
 * One reader section built from parsed blocks (EPUB XHTML, MOBI parts, FB2
 * sections). Shared by every extractor that attaches a reading structure.
 */
struct StructureSectionInput {
  int section_index = 0;
  std::string href;
  /** "text" | "image". */
  std::string kind = "text";
  /** Parsed blocks in reading order; null for a whole-section image. */
  const std::vector<HtmlBlock>* items = nullptr;
  /** A whole-section image (raw image spine item, comic page). */
  std::string raw_image_href;
  /** Title from the book's contents; empty → the first heading. */
  std::string toc_title;
  /**
   * Maps an image `src` to the href its frame carries in the image buffer;
   * "" skips the image. Default: `JoinHref(DirnameOf(href), src)`.
   */
  std::function<std::string(const std::string& src)> resolve_image;
};

/**
 * Appends a section: text blocks join `r->text` with "\n\n" and get one
 * markup span each; images and separators get empty ranges at the cursor.
 * `*utf16_off` is the running UTF-16 length of `r->text`.
 */
void AppendStructureSection(ExtractTextResult* r, TxtStructure* st,
                            const StructureSectionInput& in, int* utf16_off);

}  // namespace document
}  // namespace sherpa_onnx
