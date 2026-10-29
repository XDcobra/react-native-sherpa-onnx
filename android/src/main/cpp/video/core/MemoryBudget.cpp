#include "core/MemoryBudget.h"

#include <algorithm>

namespace sherpa_onnx {
namespace video {

MemoryBudget& MemoryBudget::Instance() {
  static MemoryBudget inst;
  return inst;
}

int64_t MemoryBudget::DefaultDecodedLimit(VideoRamClass c) {
  switch (c) {
    case VideoRamClass::Low:
      return 24LL * 1024 * 1024;
    case VideoRamClass::High:
      return 96LL * 1024 * 1024;
    case VideoRamClass::VeryHigh:
      return 160LL * 1024 * 1024;
    case VideoRamClass::Mid:
    default:
      return 48LL * 1024 * 1024;
  }
}

int64_t MemoryBudget::DefaultRingMaxBytes(VideoRamClass c) {
  switch (c) {
    case VideoRamClass::Low:
      return 16LL * 1024 * 1024;
    case VideoRamClass::High:
      return 64LL * 1024 * 1024;
    case VideoRamClass::VeryHigh:
      return 96LL * 1024 * 1024;
    case VideoRamClass::Mid:
    default:
      return 32LL * 1024 * 1024;
  }
}

VideoRamClass MemoryBudget::ClassifyRam(uint64_t totalRamBytes) {
  const uint64_t gb = 1024ull * 1024ull * 1024ull;
  if (totalRamBytes <= 3 * gb) {
    return VideoRamClass::Low;
  }
  if (totalRamBytes <= 6 * gb) {
    return VideoRamClass::Mid;
  }
  if (totalRamBytes <= 12 * gb) {
    return VideoRamClass::High;
  }
  return VideoRamClass::VeryHigh;
}

void MemoryBudget::Configure(VideoRamClass ramClass) {
  std::lock_guard<std::mutex> lock(mu_);
  ramClass_ = ramClass;
  limit_ = DefaultDecodedLimit(ramClass);
}

void MemoryBudget::SetLimitBytes(int64_t bytes) {
  std::lock_guard<std::mutex> lock(mu_);
  limit_ = std::max<int64_t>(0, bytes);
}

int64_t MemoryBudget::limitBytes() const {
  std::lock_guard<std::mutex> lock(mu_);
  return limit_;
}

int64_t MemoryBudget::usedBytes() const {
  std::lock_guard<std::mutex> lock(mu_);
  return used_;
}

bool MemoryBudget::TryReserve(int64_t bytes) {
  if (bytes <= 0) {
    return true;
  }
  std::lock_guard<std::mutex> lock(mu_);
  if (used_ + bytes > limit_) {
    return false;
  }
  used_ += bytes;
  return true;
}

void MemoryBudget::ResetUsedForTest() {
  std::lock_guard<std::mutex> lock(mu_);
  used_ = 0;
}

void MemoryBudget::Release(int64_t bytes) {
  if (bytes <= 0) {
    return;
  }
  std::lock_guard<std::mutex> lock(mu_);
  used_ = std::max<int64_t>(0, used_ - bytes);
}

}  // namespace video
}  // namespace sherpa_onnx
