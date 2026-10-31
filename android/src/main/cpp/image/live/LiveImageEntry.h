#pragma once

#include "../ImageTypes.h"

#include <atomic>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace sherpa_onnx {
namespace image {

/**
 * Live ImageBuffer: compressed JPEG/WebP/HEIC ring + optional session spool.
 * Shared kernel with offline: ImageDecoder + packed RGB8 on GetFrameRgbPtr.
 * State: recording → finished (never back). Id stays img_live_<uuid>.
 */
class LiveImageEntry {
 public:
  struct Status {
    bool ok = false;
    std::string errorCode;
    std::string errorMessage;
  };

  static std::shared_ptr<LiveImageEntry> Create(const LiveImageOptions& opts,
                                                const std::string& bufferId);

  Status AppendCompressed(std::vector<uint8_t> bytes);
  Status Finish();

  ImageBufferInfo Info() const;
  ImageBufferState state() const;
  const std::string& id() const { return id_; }

  Status EnsureFrame(int frameIndex, ImageFrameInfo* out);
  const uint8_t* GetFrameRgbPtr(int frameIndex, int* outWidth, int* outHeight);
  bool GetFrameInfo(int frameIndex, ImageFrameInfo* out) const;

  int DecodeCount() const { return decode_count_.load(); }

 private:
  LiveImageEntry(LiveImageOptions opts, std::string id);

  const CompressedImageFrame* FindCompressedLocked(int64_t index) const;
  Status MaterializeLocked(int64_t index, ImageFrameInfo* out);

  std::string id_;
  LiveImageOptions opts_;
  ImageBufferState state_ = ImageBufferState::Recording;
  mutable std::mutex mu_;
  std::deque<CompressedImageFrame> ring_;
  std::vector<CompressedImageFrame> spool_;
  int64_t total_written_ = 0;
  int64_t evicted_ = 0;
  int ring_limit_ = 16;
  int hot_limit_ = 8;
  std::atomic<int> decode_count_{0};
  uint64_t lru_clock_ = 0;

  struct HotRgb {
    RgbFrame frame;
    uint64_t lru_tick = 0;
  };
  std::unordered_map<int64_t, HotRgb> hot_;
};

}  // namespace image
}  // namespace sherpa_onnx
