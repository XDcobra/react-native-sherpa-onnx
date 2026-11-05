#pragma once

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

namespace sherpaonnx {

/**
 * Thread-safe freelist of byte vectors for JSI OwnedBuffer reuse (size-class hit rate).
 * Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (C #17).
 */
class ByteBufferPool {
 public:
  static constexpr size_t kMinClassBytes = 4 * 1024;       // 4 KiB
  static constexpr size_t kMaxClassBytes = 2 * 1024 * 1024; // 2 MiB
  static constexpr size_t kMaxPerClass = 8;

  static ByteBufferPool &instance();

  /** Return a vector with size()==minBytes and capacity suitable for pooling when released. */
  std::vector<uint8_t> acquire(size_t minBytes);

  /** Return capacity to freelist when it matches a size class; otherwise discard. */
  void release(std::vector<uint8_t> &&buf);

  /** Test helper: drop all freelist entries. */
  void clearForTesting();

  /** Test helper: freelist depth for the size class covering `bytes` (0 if not poolable). */
  size_t freelistDepthFor(size_t bytes) const;

  /** Round up to pool size class, or 0 if `bytes` exceeds kMaxClassBytes (not pooled). */
  static size_t sizeClassBytes(size_t bytes);

 private:
  ByteBufferPool() = default;

  static size_t classIndex(size_t classBytes);
  static size_t classCount();

  mutable std::mutex mu_;
  std::vector<std::vector<std::vector<uint8_t>>> freelists_; // [classIndex] -> free buffers
  bool initialized_ = false;

  void ensureInitializedLocked();
};

}  // namespace sherpaonnx
