#pragma once

#include "ReaderDocument.h"

#include <mutex>

namespace sherpa_onnx {
namespace reader {

inline constexpr const char* kErrReaderNotFound = "ERR_READER_NOT_FOUND";
inline constexpr const char* kErrReaderNoStructure = "ERR_READER_NO_STRUCTURE";
inline constexpr const char* kErrReaderUnsupportedStructure = "ERR_READER_UNSUPPORTED_STRUCTURE";
inline constexpr const char* kErrReaderInvalidArgument = "ERR_READER_INVALID_ARGUMENT";

struct ReaderError {
  std::string code;
  std::string message;
};

/**
 * Native reader documents (`rdr_*`). Each document is an immutable snapshot;
 * inserting / removing an app section publishes a new snapshot with a higher
 * revision, so views keep reading a consistent state.
 */
class ReaderRegistry {
 public:
  static ReaderRegistry& Instance();

  /**
   * @param text populated offline text buffer with a reading structure.
   * @param frameHrefs href of every frame of `imageBufferId` (may be empty).
   * @return document ID, or "" with `err`.
   */
  std::string Create(std::shared_ptr<TxtOfflineEntry> text, const std::string& imageBufferId,
                     const std::vector<std::string>& frameHrefs, const std::string& documentKey,
                     ReaderError* err);

  /** One frame of a page document. */
  struct PageInput {
    std::string href;  // archive path; empty → "page:N"
    int pageNumber = 0;  // printed as the section label when > 0
  };

  /**
   * Page document (`format: "pages"`) over an image buffer: one section per
   * frame (`kind: "page"`) whose only block `s{n}.b0` is the page. Text can
   * be attached later (OCR).
   */
  std::string CreatePages(const std::string& imageBufferId, const std::vector<PageInput>& pages,
                          const std::string& documentKey, ReaderError* err);

  /**
   * Attaches OCR text: a buffer filled by recognize() on this document's image
   * buffer (it carries a TxtOcrLayout). For each recognized frame, its blocks
   * become children `{id}.t{j}` of the page and image blocks that show the
   * frame, replacing earlier OCR text there. Publishes a new revision.
   * `attached` (optional) receives the number of blocks that got text.
   */
  bool AttachPageText(const std::string& documentId, std::shared_ptr<TxtOfflineEntry> ocr,
                      int* attached, ReaderError* err);

  bool InsertSection(const std::string& documentId, const ReaderAppSectionInput& section,
                     ReaderError* err);
  bool RemoveSection(const std::string& documentId, const std::string& sectionId,
                     ReaderError* err);

  std::shared_ptr<const ReaderSnapshot> Snapshot(const std::string& documentId) const;
  bool Release(const std::string& documentId);

 private:
  mutable std::mutex mutex_;
  std::unordered_map<std::string, std::shared_ptr<const ReaderSnapshot>> docs_;
  uint64_t nextId_ = 1;
};

/** Placeholder document (`debugRowCount`): `rows` text blocks, 10 per section. */
std::shared_ptr<const ReaderSnapshot> MakePlaceholderSnapshot(int rows);

/** Gives a block its own text (app blocks, OCR-derived text copies). */
void SetOwnBlockText(ReaderBlock* b, std::string text);

/**
 * Points text blocks at `source` and resolves their UTF-8 byte ranges from
 * `utf16Start/End` in one forward pass (blocks must not overlap).
 */
void ResolveByteRanges(const std::shared_ptr<const std::string>& source,
                       std::vector<ReaderBlock*>* blocks);

/** Rebuilds the ID maps of a snapshot after its sections / blocks changed. */
void ReindexSnapshot(ReaderSnapshot* snap);

/**
 * Index of the block whose textHash equals `textHash`, nearest to `hintIndex`;
 * -1 if none. Used to remap stored positions after a structure change.
 */
int RemapBlockByHash(const ReaderSnapshot& snap, const std::string& textHash, int hintIndex);

}  // namespace reader
}  // namespace sherpa_onnx
