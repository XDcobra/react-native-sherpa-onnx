#pragma once

#include <memory>
#include <string>
#include <vector>

/**
 * Reading structure of an offline text buffer (reader structure v1, see
 * docs/reader.md): sections → blocks with UTF-16 ranges into the buffer text.
 * Filled by document extractors (EPUB today); stays in native memory next to
 * the text and is released with the buffer.
 */
enum class TxtBlockType : int { Paragraph = 0, Heading = 1, Image = 2, Separator = 3 };

inline const char *txt_block_type_name(TxtBlockType t) {
  switch (t) {
    case TxtBlockType::Heading: return "heading";
    case TxtBlockType::Image: return "image";
    case TxtBlockType::Separator: return "separator";
    default: return "paragraph";
  }
}

struct TxtStructBlock {
  TxtBlockType type = TxtBlockType::Paragraph;
  int sectionIndex = 0;
  int blockIndex = 0;  // within the section, counts every block
  int utf16Start = 0;  // image / separator: empty range at the cursor
  int utf16End = 0;
  int headingLevel = 0;
  std::string imageHref;  // archive path of the image (images only)
  std::string alt;
  bool hasAlt = false;
};

struct TxtStructSection {
  int sectionIndex = 0;
  std::string href;
  std::string kind;  // "text" | "image"
  std::string title;
  std::string titleSource = "none";  // "toc" | "heading" | "none"
  int utf16Start = 0;
  int utf16End = 0;
  int firstBlock = 0;  // index into TxtStructure::blocks
  int blockCount = 0;
};

struct TxtStructure {
  int version = 1;
  std::vector<TxtStructSection> sections;
  std::vector<TxtStructBlock> blocks;
  std::string title;
  std::string creator;
  std::string language;
};
