#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

/**
 * Reading structure of an offline text buffer (see docs/reader.md): sections
 * → blocks with UTF-16 ranges into the buffer text. Filled by document and PDF
 * extractors; stays in native memory next to the text and is released with
 * the buffer.
 */
enum class TxtBlockType : int {
  Paragraph = 0,
  Heading = 1,
  Image = 2,
  Separator = 3,
  Page = 4,  // page image of a page-based document (PDF, comic)
};

inline const char *txt_block_type_name(TxtBlockType t) {
  switch (t) {
    case TxtBlockType::Heading: return "heading";
    case TxtBlockType::Image: return "image";
    case TxtBlockType::Separator: return "separator";
    case TxtBlockType::Page: return "page";
    default: return "paragraph";
  }
}

/** TxtStructBlock::flags. */
enum TxtBlockFlags : uint32_t {
  kTxtBlockFurniture = 1u << 0,  // running header / footer / page number
};

/** TxtStyleRun::flags. */
enum TxtStyleFlags : uint32_t {
  kTxtStyleItalic = 1u << 0,
  kTxtStyleBold = 1u << 1,
};

/**
 * An inline style over [start, end) UTF-16 units of a block's text (relative to
 * the block, not the buffer). A layer next to the text: it never changes the
 * text, its ranges, hashes or IDs. Runs are sorted, do not overlap and carry
 * the combined flags (bold inside italic = one run with both).
 */
struct TxtStyleRun {
  int start = 0;
  int end = 0;
  uint32_t flags = 0;  // TxtStyleFlags
};

struct TxtStructBlock {
  TxtBlockType type = TxtBlockType::Paragraph;
  int sectionIndex = 0;
  int blockIndex = 0;  // within the section, counts every block
  int utf16Start = 0;  // image / separator: empty range at the cursor
  int utf16End = 0;
  int headingLevel = 0;
  uint32_t flags = 0;  // TxtBlockFlags
  /** Frame of the document's image buffer, when known directly (PDF pages). */
  int frameIndex = -1;
  /** Normalized rectangle on its page (x, y, w, h in 0..1), if known. */
  bool hasRect = false;
  float rect[4] = {0, 0, 0, 0};
  std::string imageHref;  // archive path of the image (images only)
  std::string alt;
  bool hasAlt = false;
  /** Inline italic / bold of a text block (EPUB, MOBI, FB2); empty otherwise. */
  std::vector<TxtStyleRun> styles;
};

struct TxtStructSection {
  int sectionIndex = 0;
  std::string href;
  std::string kind;  // "text" | "image"
  std::string title;
  std::string titleSource = "none";  // "toc" | "heading" | "none"
  /** Printed page label of a PDF page ("iv", "12"); empty otherwise. */
  std::string label;
  int utf16Start = 0;
  int utf16End = 0;
  int firstBlock = 0;  // index into TxtStructure::blocks
  int blockCount = 0;
};

/** One entry of the book's contents. */
struct TxtTocEntry {
  std::string title;
  int level = 1;          // nesting depth, from 1
  int sectionIndex = 0;   // TxtStructSection::sectionIndex
  int blockIndex = -1;    // block within the section; -1 = section start
};

struct TxtStructure {
  /** "epub" | "fb2" | "mobi" | "pdf" | "pages"; each format versions its rules. */
  std::string format = "epub";
  int version = 1;
  std::vector<TxtStructSection> sections;
  std::vector<TxtStructBlock> blocks;
  std::string title;
  std::string creator;
  std::string language;
  /** Contents in reading order (nav / NCX, FB2 titles, PDF outline); may be empty. */
  std::vector<TxtTocEntry> toc;
};
