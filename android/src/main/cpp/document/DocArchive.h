#pragma once

#include "DocTypes.h"

#include <cstdint>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace document {

struct ArchiveEntryInfo {
  std::string name;
  int64_t size = 0;
  bool encrypted = false;
};

/**
 * Seekable libarchive reader (ZIP + RAR + RAR5). No stream-only path.
 * Catalog is a skip-data pass; ReadNamed reopens and scans (seekable ZIP/RAR).
 */
class ArchiveReader {
 public:
  ArchiveReader() = default;
  ~ArchiveReader();
  ArchiveReader(const ArchiveReader&) = delete;
  ArchiveReader& operator=(const ArchiveReader&) = delete;
  ArchiveReader(ArchiveReader&&) noexcept;
  ArchiveReader& operator=(ArchiveReader&&) noexcept;

  static bool Open(const DocumentSource& src, ArchiveReader* out,
                   std::string* err_code, std::string* err_message);

  const std::vector<ArchiveEntryInfo>& catalog() const { return catalog_; }
  int64_t claimed_uncompressed() const { return claimed_uncompressed_; }

  bool HasEntry(const std::string& name) const;
  /** Case-sensitive archive path; tries slash-normalized name. */
  bool ReadNamed(const std::string& name, std::vector<uint8_t>* data,
                 std::string* err_code, std::string* err_message);

  bool ReadIndex(size_t catalog_index, std::vector<uint8_t>* data,
                 std::string* err_code, std::string* err_message);

 private:
  bool LoadCatalog(std::string* err_code, std::string* err_message);
  bool OpenFresh(void** archive_out, std::string* err_code,
                 std::string* err_message);
  void CloseFresh(void* archive);

  DocumentSource src_;
  std::vector<ArchiveEntryInfo> catalog_;
  int64_t claimed_uncompressed_ = 0;
};

bool ReadSourcePrefix(const DocumentSource& src, uint8_t* buf, size_t n,
                      size_t* got, std::string* err_code,
                      std::string* err_message);

std::string NormalizeArchivePath(std::string name);

}  // namespace document
}  // namespace sherpa_onnx
