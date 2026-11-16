#pragma once

#include "ImageTypes.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
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
  /** Reads a slot's encoded bytes on demand (e.g. an archive entry); may run on any thread. */
  using Loader = std::function<bool(std::vector<uint8_t>* bytes, std::string* err_code,
                                    std::string* err_message)>;

  struct Slot {
    std::string path;
    std::vector<uint8_t> bytes;
    Loader loader;
    /** Decoded size when known up front (see ImageFrameInfo::expectedWidth); 0 = unknown. */
    int expectedWidth = 0;
    int expectedHeight = 0;
  };

  explicit ImageFileLazyBackend(DecodeOptions opts);

  void AddPath(std::string path);
  /** Encoded bytes kept in memory; the decoded size is read from the headers. */
  void AddBytes(std::vector<uint8_t> bytes);
  void AddLoader(Loader loader, int expectedWidth, int expectedHeight);

  int frame_count() const;
  /** Decoded size known before decoding, or false. */
  bool ExpectedSize(int index, int* width, int* height) const;
  const DecodeOptions& opts() const { return opts_; }
  int decode_count() const { return decode_count_.load(); }

  /**
   * Decode one 0-based slot into packed RGB8 (JPEG/PNG/WebP via ImageDecoder;
   * HEIC via platform hook).
   */
  bool DecodeFrame(int index, RgbFrame* out, std::string* err_code,
                   std::string* err_message);

  std::string lastProvider() const;
  std::string lastTier() const;
  std::string lastOrigin() const;

 private:
  DecodeOptions opts_;
  std::vector<Slot> slots_;
  std::atomic<int> decode_count_{0};
  mutable std::mutex mu_;
  std::string lastProvider_;
  std::string lastTier_;
  std::string lastOrigin_;
};

}  // namespace image
}  // namespace sherpa_onnx
