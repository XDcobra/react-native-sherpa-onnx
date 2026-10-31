#pragma once

#include "ImageTypes.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace image {

/**
 * Retained compressed file/bytes backend for lazy-lru OfflineImageBuffer slots.
 * ImageRegistry owns one backend per lazy file buffer. Decode happens on EnsureFrame.
 */
class ImageFileLazyBackend {
 public:
  struct Slot {
    std::string path;
    std::vector<uint8_t> bytes;
  };

  explicit ImageFileLazyBackend(DecodeOptions opts);

  void AddPath(std::string path);
  void AddBytes(std::vector<uint8_t> bytes);

  int frame_count() const;
  const DecodeOptions& opts() const { return opts_; }
  int decode_count() const { return decode_count_.load(); }

  /**
   * Decode one 0-based slot into packed RGB8 (JPEG/PNG/WebP via ImageDecoder;
   * HEIC via platform hook).
   */
  bool DecodeFrame(int index, RgbFrame* out, std::string* err_code,
                   std::string* err_message);

 private:
  DecodeOptions opts_;
  std::vector<Slot> slots_;
  std::atomic<int> decode_count_{0};
};

}  // namespace image
}  // namespace sherpa_onnx
