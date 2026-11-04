#pragma once

#include "ByteBufferPool.h"

#include <jsi/jsi.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <utility>
#include <vector>

namespace sherpa {

/**
 * jsi::MutableBuffer backed by ByteBufferPool (A9).
 * Returns capacity to the pool in the destructor when JS drops the ArrayBuffer.
 */
class OwnedBuffer : public facebook::jsi::MutableBuffer {
 public:
  explicit OwnedBuffer(size_t logicalBytes)
      : buf_(sherpaonnx::ByteBufferPool::instance().acquire(logicalBytes)),
        logical_(logicalBytes) {}

  OwnedBuffer(const OwnedBuffer &) = delete;
  OwnedBuffer &operator=(const OwnedBuffer &) = delete;

  ~OwnedBuffer() override {
    sherpaonnx::ByteBufferPool::instance().release(std::move(buf_));
  }

  size_t size() const override { return logical_; }

  uint8_t *data() override { return buf_.empty() ? nullptr : buf_.data(); }

  /** Adjust ArrayBuffer-reported length; grows storage if needed; never shrink_to_fit. */
  void resize(size_t logicalBytes) {
    if (logicalBytes > buf_.size()) {
      if (logicalBytes > buf_.capacity()) {
        // Outgrew pooled capacity — allocate fresh (release will pool if class fits).
        std::vector<uint8_t> grown =
            sherpaonnx::ByteBufferPool::instance().acquire(logicalBytes);
        if (!buf_.empty() && !grown.empty()) {
          const size_t copyBytes = std::min(buf_.size(), grown.size());
          std::memcpy(grown.data(), buf_.data(), copyBytes);
        }
        sherpaonnx::ByteBufferPool::instance().release(std::move(buf_));
        buf_ = std::move(grown);
      } else {
        buf_.resize(logicalBytes);
      }
    }
    logical_ = logicalBytes;
  }

 private:
  std::vector<uint8_t> buf_;
  size_t logical_ = 0;
};

}  // namespace sherpa
