#include "DocSniff.h"

#include "DocPath.h"

#include <cstring>

namespace sherpa_onnx {
namespace document {

namespace {

bool StartsWith(const uint8_t* b, size_t n, const char* lit) {
  const size_t L = std::strlen(lit);
  if (n < L) return false;
  return std::memcmp(b, lit, L) == 0;
}

}  // namespace

DocFormat SniffFormat(const DocumentSource& src, ArchiveReader* archive_or_null,
                      std::string* err_code, std::string* err_message) {
  uint8_t prefix[80];
  size_t got = 0;
  if (!ReadSourcePrefix(src, prefix, sizeof(prefix), &got, err_code,
                        err_message)) {
    return DocFormat::Unknown;
  }
  if (got >= 4 && prefix[0] == 0x50 && prefix[1] == 0x4B &&
      (prefix[2] == 0x03 || prefix[2] == 0x05 || prefix[2] == 0x07) &&
      (prefix[3] == 0x04 || prefix[3] == 0x06 || prefix[3] == 0x08)) {
    ArchiveReader local;
    ArchiveReader* ar = archive_or_null;
    if (!ar) {
      if (!ArchiveReader::Open(src, &local, err_code, err_message)) {
        return DocFormat::Unknown;
      }
      ar = &local;
    }
    bool has_container = false;
    bool has_fb2 = false;
    for (const auto& e : ar->catalog()) {
      if (e.name == "META-INF/container.xml" || e.name == "mimetype") {
        has_container = true;
      }
      std::string lower = e.name;
      for (char& c : lower) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
      }
      if (lower.size() >= 4 && lower.compare(lower.size() - 4, 4, ".fb2") == 0) {
        has_fb2 = true;
      }
    }
    if (has_container) return DocFormat::Epub;
    if (has_fb2) return DocFormat::Fb2;
    return DocFormat::Cbz;
  }
  if (got >= 7 && std::memcmp(prefix, "Rar!\x1a\x07", 6) == 0) {
    return DocFormat::Cbr;
  }
  if (got >= 4 && StartsWith(prefix, got, "%PDF")) {
    return DocFormat::Pdf;
  }
  if (got >= 68 && std::memcmp(prefix + 60, "BOOKMOBI", 8) == 0) {
    return DocFormat::Mobi;
  }
  if (got >= 8 && std::memcmp(prefix + 60, "TEXtREAd", 8) == 0) {
    return DocFormat::Mobi;
  }
  // Uncompressed FB2 / XML
  std::string head(reinterpret_cast<const char*>(prefix), got);
  if (head.find("FictionBook") != std::string::npos ||
      head.find("<FictionBook") != std::string::npos) {
    return DocFormat::Fb2;
  }
  if (head.find("<html") != std::string::npos ||
      head.find("<HTML") != std::string::npos ||
      head.find("<!DOCTYPE html") != std::string::npos) {
    if (err_code) *err_code = kErrUnsupportedFormat;
    if (err_message) *err_message = "Standalone HTML is not an e-document";
    return DocFormat::Unknown;
  }
  if (err_code) *err_code = kErrUnsupportedFormat;
  if (err_message) *err_message = "Unrecognized document container";
  return DocFormat::Unknown;
}

}  // namespace document
}  // namespace sherpa_onnx
