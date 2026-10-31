#include "core/AlignedBuffer.h"

#include <cstdlib>
#include <cstring>

namespace sherpa_onnx {
namespace video {

AlignedBuffer::AlignedBuffer(AlignedBuffer&& other) noexcept
    : ptr_(other.ptr_), size_(other.size_), alignment_(other.alignment_) {
  other.ptr_ = nullptr;
  other.size_ = 0;
}

AlignedBuffer& AlignedBuffer::operator=(AlignedBuffer&& other) noexcept {
  if (this == &other) {
    return *this;
  }
  Reset();
  ptr_ = other.ptr_;
  size_ = other.size_;
  alignment_ = other.alignment_;
  other.ptr_ = nullptr;
  other.size_ = 0;
  return *this;
}

AlignedBuffer::~AlignedBuffer() { Reset(); }

void AlignedBuffer::Reset() {
  if (ptr_ != nullptr) {
    std::free(ptr_);
    ptr_ = nullptr;
  }
  size_ = 0;
}

Status AlignedBuffer::Allocate(size_t bytes, size_t alignment) {
  Reset();
  if (bytes == 0) {
    return Status::Fail(kErrInvalidArgument, "AlignedBuffer size 0");
  }
  if (alignment < sizeof(void*) || (alignment & (alignment - 1)) != 0) {
    return Status::Fail(kErrInvalidArgument, "alignment must be power of two");
  }
  alignment_ = alignment;
  const size_t rounded = (bytes + alignment - 1) & ~(alignment - 1);
#if defined(_WIN32)
  ptr_ = _aligned_malloc(rounded, alignment);
  if (ptr_ == nullptr) {
    return Status::Fail(kErrMemoryBudget, "aligned alloc failed");
  }
#else
  void* p = nullptr;
  if (posix_memalign(&p, alignment, rounded) != 0 || p == nullptr) {
    return Status::Fail(kErrMemoryBudget, "posix_memalign failed");
  }
  ptr_ = p;
#endif
  size_ = rounded;
  std::memset(ptr_, 0, size_);
  return Status::Ok();
}

}  // namespace video
}  // namespace sherpa_onnx
