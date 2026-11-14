#pragma once

#include "../textbuffer/TxtOfflineEntry.h"

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace sherpa_onnx {
namespace reader {

/** Version of the EPUB structure rules (TxtStructure::version for format "epub"). */
inline constexpr int kStructureVersion = 1;

/**
 * Structure rules version this core reads for a format ("epub", "fb2", "mobi",
 * "pdf", "pages"); 0 for an unknown format. Each format versions its rules on
 * its own, so a change for one format keeps the IDs of the others.
 */
int SupportedStructureVersion(const std::string& format);

enum class ReaderBlockType : int {
  Paragraph = 0,
  Heading = 1,
  Image = 2,
  Separator = 3,
  /** A page image (PDF page, comic page); `s{n}.b0` of a page section. */
  Page = 4,
};

/** ReaderBlock::flags. */
enum ReaderBlockFlags : uint32_t {
  kBlockFurniture = 1u << 0,  // running header / footer / page number
};

const char* ReaderBlockTypeName(ReaderBlockType t);

struct ReaderBlock {
  std::string id;  // "s3.b12" | "app:guide.intro"
  int section = 0;  // index into ReaderSnapshot::sections
  ReaderBlockType type = ReaderBlockType::Paragraph;
  int headingLevel = 0;
  std::string textHash;
  /** Text block of the document's primary text buffer (has `utf16Start/End`). */
  bool fromFile = true;
  int utf16Start = 0;  // file text blocks: range in the primary text buffer
  int utf16End = 0;
  /**
   * The block's text: UTF-8 bytes [textByteStart, textByteEnd) of *textSource,
   * textUtf16Len UTF-16 units. File and OCR blocks alias their text buffer;
   * app blocks own a string. Null for images, pages and separators.
   */
  std::shared_ptr<const std::string> textSource;
  int textByteStart = 0;
  int textByteEnd = 0;
  int textUtf16Len = 0;
  uint32_t flags = 0;  // ReaderBlockFlags
  /** Normalized rectangle on its page / image (x, y, w, h in 0..1), if known. */
  bool hasRect = false;
  float rect[4] = {0, 0, 0, 0};
  std::string imageHref;
  std::string alt;
  bool hasAlt = false;
  int imageFrame = -1;  // frame in the document's image buffer, -1 if none
};

struct ReaderSection {
  std::string id;  // "s3" | "app:guide"
  int sectionIndex = -1;  // file sections; -1 for app sections
  bool app = false;
  std::string kind;  // "text" | "image"
  std::string href;
  std::string title;
  std::string titleSource;  // "toc" | "heading" | "app" | "none"
  int firstBlock = 0;
  int blockCount = 0;
};

/** Immutable view of a reader document at one revision. */
struct ReaderSnapshot {
  std::string documentId;
  int revision = 0;
  std::string documentKey;
  /** "epub" | "fb2" | "mobi" | "pdf" | "pages". */
  std::string format;
  int structureVersion = 0;
  std::string imageBufferId;
  std::shared_ptr<TxtOfflineEntry> text;  // keeps the text alive
  std::vector<ReaderSection> sections;
  std::vector<ReaderBlock> blocks;
  std::unordered_map<std::string, int> blockIndexById;
  std::unordered_map<std::string, int> sectionIndexById;
  std::string title;
  std::string creator;
  std::string language;
  /** File text blocks (non-empty buffer range) in buffer order, for offset lookups. */
  std::vector<int> textBlocks;

  /** UTF-8 text of a block ("" for images / separators). */
  std::string BlockText(int index) const;
  /** Length of a block's text in UTF-16 units. */
  int BlockLength(int index) const;
  int BlockIndex(const std::string& blockId) const;
  int SectionIndex(const std::string& sectionId) const;

  /**
   * Maps a text-buffer UTF-16 range [start, end) onto file text blocks.
   * The start snaps forward and the end backward over the gaps between blocks
   * (the "\n\n" joins), so the result covers only shown text. Returns false
   * when the range touches no file text block.
   */
  bool MapTextRange(int start, int end, int* fromBlock, int* fromOffset, int* toBlock,
                    int* toOffset) const;
};

struct ReaderAppBlockInput {
  std::string key;  // [A-Za-z0-9_-]+, unique in the section
  ReaderBlockType type = ReaderBlockType::Paragraph;  // no images in app sections
  std::string text;
  int level = 0;
};

struct ReaderAppSectionInput {
  std::string after;  // existing section ID
  std::string id;  // "app:<id>"
  std::string title;
  std::vector<ReaderAppBlockInput> blocks;
};

}  // namespace reader
}  // namespace sherpa_onnx
