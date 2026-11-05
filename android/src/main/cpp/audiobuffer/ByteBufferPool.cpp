#include "ByteBufferPool.h"

#include <algorithm>

namespace sherpaonnx {
namespace {

size_t nextPow2AtLeast(size_t n) {
  if (n <= 1) {
    return 1;
  }
  --n;
  n |= n >> 1;
  n |= n >> 2;
  n |= n >> 4;
  n |= n >> 8;
  n |= n >> 16;
#if SIZE_MAX > 0xffffffffu
  n |= n >> 32;
#endif
  return n + 1;
}

}  // namespace

ByteBufferPool &ByteBufferPool::instance() {
  static ByteBufferPool pool;
  return pool;
}

size_t ByteBufferPool::sizeClassBytes(size_t bytes) {
  if (bytes == 0) {
    return 0;
  }
  const size_t rounded = nextPow2AtLeast(std::max(bytes, kMinClassBytes));
  if (rounded > kMaxClassBytes) {
    return 0;
  }
  return rounded;
}

size_t ByteBufferPool::classCount() {
  size_t n = 0;
  for (size_t c = kMinClassBytes; c <= kMaxClassBytes; c <<= 1) {
    ++n;
  }
  return n;
}

size_t ByteBufferPool::classIndex(size_t classBytes) {
  size_t idx = 0;
  for (size_t c = kMinClassBytes; c <= kMaxClassBytes; c <<= 1) {
    if (c == classBytes) {
      return idx;
    }
    ++idx;
  }
  return classCount();
}

void ByteBufferPool::ensureInitializedLocked() {
  if (initialized_) {
    return;
  }
  freelists_.assign(classCount(), {});
  initialized_ = true;
}

std::vector<uint8_t> ByteBufferPool::acquire(size_t minBytes) {
  if (minBytes == 0) {
    bypass_.fetch_add(1, std::memory_order_relaxed);
    acquires_.fetch_add(1, std::memory_order_relaxed);
    return {};
  }

  const size_t cls = sizeClassBytes(minBytes);
  if (cls == 0) {
    bypass_.fetch_add(1, std::memory_order_relaxed);
    acquires_.fetch_add(1, std::memory_order_relaxed);
    return std::vector<uint8_t>(minBytes);
  }

  acquires_.fetch_add(1, std::memory_order_relaxed);

  {
    std::lock_guard<std::mutex> lock(mu_);
    ensureInitializedLocked();
    auto &bucket = freelists_[classIndex(cls)];
    if (!bucket.empty()) {
      std::vector<uint8_t> v = std::move(bucket.back());
      bucket.pop_back();
      v.resize(minBytes);
      hits_.fetch_add(1, std::memory_order_relaxed);
      return v;
    }
  }

  misses_.fetch_add(1, std::memory_order_relaxed);
  std::vector<uint8_t> v;
  v.reserve(cls);
  v.resize(minBytes);
  return v;
}

void ByteBufferPool::release(std::vector<uint8_t> &&buf) {
  // Only pool exact size-class capacities (acquire uses reserve(cls)).
  // Oversize vectors (capacity outside / not equal to a class) are discarded.
  const size_t cap = buf.capacity();
  const size_t cls = sizeClassBytes(cap);
  if (cls == 0 || cls != cap) {
    releases_discarded_.fetch_add(1, std::memory_order_relaxed);
    return;
  }

  std::lock_guard<std::mutex> lock(mu_);
  ensureInitializedLocked();
  auto &bucket = freelists_[classIndex(cls)];
  if (bucket.size() >= kMaxPerClass) {
    releases_discarded_.fetch_add(1, std::memory_order_relaxed);
    return;
  }
  buf.clear();
  bucket.push_back(std::move(buf));
  releases_pooled_.fetch_add(1, std::memory_order_relaxed);
}

ByteBufferPool::Stats ByteBufferPool::stats() const {
  Stats s;
  s.acquires = acquires_.load(std::memory_order_relaxed);
  s.hits = hits_.load(std::memory_order_relaxed);
  s.misses = misses_.load(std::memory_order_relaxed);
  s.bypass = bypass_.load(std::memory_order_relaxed);
  s.releases_pooled = releases_pooled_.load(std::memory_order_relaxed);
  s.releases_discarded = releases_discarded_.load(std::memory_order_relaxed);
  return s;
}

void ByteBufferPool::resetStats() {
  acquires_.store(0, std::memory_order_relaxed);
  hits_.store(0, std::memory_order_relaxed);
  misses_.store(0, std::memory_order_relaxed);
  bypass_.store(0, std::memory_order_relaxed);
  releases_pooled_.store(0, std::memory_order_relaxed);
  releases_discarded_.store(0, std::memory_order_relaxed);
}

void ByteBufferPool::clearForTesting() {
  std::lock_guard<std::mutex> lock(mu_);
  ensureInitializedLocked();
  for (auto &bucket : freelists_) {
    bucket.clear();
  }
  resetStats();
}

size_t ByteBufferPool::freelistDepthFor(size_t bytes) const {
  const size_t cls = sizeClassBytes(bytes == 0 ? 1 : bytes);
  if (cls == 0) {
    return 0;
  }
  std::lock_guard<std::mutex> lock(mu_);
  if (!initialized_) {
    return 0;
  }
  const size_t idx = classIndex(cls);
  if (idx >= freelists_.size()) {
    return 0;
  }
  return freelists_[idx].size();
}

}  // namespace sherpaonnx
