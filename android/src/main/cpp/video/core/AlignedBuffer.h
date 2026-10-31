#pragma once

#include <cstddef>
#include <cstdint>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

/** 64-byte-aligned owning buffer (posix_memalign / aligned_alloc). */
class AlignedBuffer {
 public:
  AlignedBuffer() = default;
  AlignedBuffer(const AlignedBuffer&) = delete;
  AlignedBuffer& operator=(const AlignedBuffer&) = delete;
  AlignedBuffer(AlignedBuffer&& other) noexcept;
  AlignedBuffer& operator=(AlignedBuffer&& other) noexcept;
  ~AlignedBuffer();

  Status Allocate(size_t bytes, size_t alignment = kAlignBytes);
  void Reset();

  uint8_t* data() { return static_cast<uint8_t*>(ptr_); }
  const uint8_t* data() const { return static_cast<const uint8_t*>(ptr_); }
  size_t size() const { return size_; }
  size_t alignment() const { return alignment_; }
  bool empty() const { return ptr_ == nullptr || size_ == 0; }

 private:
  void* ptr_ = nullptr;
  size_t size_ = 0;
  size_t alignment_ = kAlignBytes;
};

}  // namespace video
}  // namespace sherpa_onnx
