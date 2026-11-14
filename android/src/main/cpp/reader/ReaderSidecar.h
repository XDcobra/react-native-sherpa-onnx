#pragma once

#include "ReaderDocument.h"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace sherpa_onnx {
namespace reader {

inline constexpr const char* kErrReaderSidecarInvalid = "ERR_READER_SIDECAR_INVALID";
inline constexpr const char* kErrReaderSidecarMismatch = "ERR_READER_SIDECAR_MISMATCH";

/** Sidecar file format version (`sherpa_reader_ocr_v1`). */
inline constexpr uint32_t kReaderSidecarVersion = 1;

/** One page (or image) with its OCR text blocks, as stored in a sidecar. */
struct SidecarPage {
  std::string parentBlockId;  // "s4.b0"
  int frame = -1;  // image frame of the parent, checked on load
  std::string family;  // OCR family that produced the text
  std::vector<ReaderBlock> blocks;  // children; text owned
};

struct SidecarContent {
  std::string documentKey;
  std::string modelId;  // optional; given by the app on save
  std::vector<SidecarPage> pages;
};

/**
 * Recognized pages of a snapshot: every page / image block with OCR text
 * children (`{id}.t{j}`), with the children's type, level, flags, rect, line
 * boxes and text.
 */
SidecarContent CollectRecognition(const ReaderSnapshot& snap, const std::string& modelId);

/** Binary encoding: magic "SHRDOCR\0", version, then length-prefixed fields (little-endian). */
std::vector<uint8_t> EncodeSidecar(const SidecarContent& content);

/** False with `error` (kErrReaderSidecarInvalid) for a file that is not a valid sidecar. */
bool DecodeSidecar(const uint8_t* data, size_t size, SidecarContent* out, std::string* error);

}  // namespace reader
}  // namespace sherpa_onnx
