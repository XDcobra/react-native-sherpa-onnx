#pragma once

#include "../textbuffer/TxtOfflineEntry.h"

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace sherpa_onnx {
namespace reader {

/** Version of the structure rules this core reads (TxtStructure::version). */
inline constexpr int kStructureVersion = 1;

enum class ReaderBlockType : int { Paragraph = 0, Heading = 1, Image = 2, Separator = 3 };

const char* ReaderBlockTypeName(ReaderBlockType t);

struct ReaderBlock {
  std::string id;  // "s3.b12" | "app:path-a.intro"
  int section = 0;  // index into ReaderSnapshot::sections
  ReaderBlockType type = ReaderBlockType::Paragraph;
  int headingLevel = 0;
  std::string textHash;
  bool fromFile = true;
  int utf16Start = 0;  // file text blocks: range in the text buffer
  int utf16End = 0;
  std::string appText;  // app text blocks
  std::string imageHref;
  std::string alt;
  bool hasAlt = false;
  int imageFrame = -1;  // frame in the document's image buffer, -1 if none
};

struct ReaderSection {
  std::string id;  // "s3" | "app:path-a"
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
  std::string imageBufferId;
  std::shared_ptr<TxtOfflineEntry> text;  // keeps the text alive
  std::vector<ReaderSection> sections;
  std::vector<ReaderBlock> blocks;
  std::unordered_map<std::string, int> blockIndexById;
  std::unordered_map<std::string, int> sectionIndexById;
  std::string title;
  std::string creator;
  std::string language;

  /** UTF-8 text of a block ("" for images / separators). */
  std::string BlockText(int index) const;
  int BlockIndex(const std::string& blockId) const;
  int SectionIndex(const std::string& sectionId) const;
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
