#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "ImageTypes.h"

namespace sherpa_onnx {
namespace document {

inline constexpr const char* kErrArchiveDisabled = "ERR_DOC_ARCHIVE_DISABLED";
inline constexpr const char* kErrUnsupportedFormat = "ERR_DOC_UNSUPPORTED_FORMAT";
inline constexpr const char* kErrDrm = "ERR_DOC_DRM";
inline constexpr const char* kErrOpenFailed = "ERR_DOC_OPEN_FAILED";
inline constexpr const char* kErrNoText = "ERR_DOC_NO_TEXT";
inline constexpr const char* kErrNoImages = "ERR_DOC_NO_IMAGES";
inline constexpr const char* kErrInvalidArgument = "ERR_DOC_INVALID_ARGUMENT";
inline constexpr const char* kErrCancelled = "ERR_DOC_CANCELLED";
inline constexpr const char* kErrParseFailed = "ERR_DOC_PARSE_FAILED";

inline constexpr int kMaxArchiveEntries = 10000;
inline constexpr int64_t kMaxEntryBytes = 64LL * 1024 * 1024;
inline constexpr int64_t kMaxUncompressedBytes = 512LL * 1024 * 1024;

enum class DocFormat {
  Unknown = 0,
  Epub,
  Fb2,
  Cbz,
  Cbr,
  Mobi,
  Pdf,
};

inline const char* FormatName(DocFormat f) {
  switch (f) {
    case DocFormat::Epub: return "epub";
    case DocFormat::Fb2: return "fb2";
    case DocFormat::Cbz: return "cbz";
    case DocFormat::Cbr: return "cbr";
    case DocFormat::Mobi: return "mobi";
    case DocFormat::Pdf: return "pdf";
    default: return "";
  }
}

struct DocumentSource {
  std::string path;
  int fd = -1;
};

struct ExtractOptions {
  int max_side = 4096;
  std::function<bool()> is_cancelled;
  std::function<void(int done, int total, const char* phase)> on_progress;
};

struct DocSection {
  int section_index = 0;
  std::string href;
  std::string kind;  // "text" | "image"
};

struct DocTextSpan {
  int utf16_start = 0;
  int utf16_end = 0;
  std::string level = "block";
  int section_index = 0;
  std::string href;
};

struct ExtractTextResult {
  bool ok = false;
  std::string error_code;
  std::string error_message;
  std::string text;
  std::string format;
  std::vector<DocSection> sections;
  std::vector<DocSection> image_only_sections;
  std::vector<DocTextSpan> spans;
};

struct DocImageFrame {
  sherpa_onnx::image::RgbFrame rgb;
  int section_index = 0;
  std::string href;
  int page_number = 0;  // 1-based comic display index; 0 unset
};

struct ExtractImagesResult {
  bool ok = false;
  std::string error_code;
  std::string error_message;
  std::string format;
  std::vector<DocImageFrame> frames;
};

inline bool Cancelled(const ExtractOptions& o) {
  return o.is_cancelled && o.is_cancelled();
}

inline void Progress(const ExtractOptions& o, int done, int total,
                     const char* phase) {
  if (o.on_progress) {
    o.on_progress(done, total, phase);
  }
}

}  // namespace document
}  // namespace sherpa_onnx
