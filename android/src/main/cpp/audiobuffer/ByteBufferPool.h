#pragma once

#include <atomic>
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
  static constexpr size_t kMinClassBytes = 4 * 1024;        // 4 KiB
  static constexpr size_t kMaxClassBytes = 2 * 1024 * 1024;  // 2 MiB
  static constexpr size_t kMaxPerClass = 8;

  struct Stats {
    uint64_t acquires = 0;
    uint64_t hits = 0;
    uint64_t misses = 0;             // new alloc in a poolable class
    uint64_t bypass = 0;             // size 0 or oversize (not poolable)
    uint64_t releases_pooled = 0;
    uint64_t releases_discarded = 0;  // oversize / depth cap / empty
  };

  static ByteBufferPool &instance();

  /** Return a vector with size()==minBytes and capacity suitable for pooling when released. */
  std::vector<uint8_t> acquire(size_t minBytes);

  /** Return capacity to freelist when it matches a size class; otherwise discard. */
  void release(std::vector<uint8_t> &&buf);

  /** Snapshot counters (C #17 hit-rate). */
  Stats stats() const;

  /** Zero counters (bench / tests). Does not clear freelist. */
  void resetStats();

  /** Test helper: drop all freelist entries (+ reset stats). */
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
  std::vector<std::vector<std::vector<uint8_t>>> freelists_;  // [classIndex] -> free buffers
  bool initialized_ = false;

  std::atomic<uint64_t> acquires_{0};
  std::atomic<uint64_t> hits_{0};
  std::atomic<uint64_t> misses_{0};
  std::atomic<uint64_t> bypass_{0};
  std::atomic<uint64_t> releases_pooled_{0};
  std::atomic<uint64_t> releases_discarded_{0};

  void ensureInitializedLocked();
};

}  // namespace sherpaonnx
