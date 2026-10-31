#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "VideoTypes.h"
#include "core/AlignedBuffer.h"
#include "core/FrameLease.h"

namespace sherpa_onnx {
namespace video {

struct SlabSlot {
  int width = 0;
  int height = 0;
  VideoPixelFormat format = VideoPixelFormat::Nv12;
  int stride[3] = {0, 0, 0};
  uint8_t* plane[3] = {nullptr, nullptr, nullptr};
  int64_t bytes = 0;
  int pins = 0;
  bool mmap = false;
  std::string path;
  void* mapAddr = nullptr;
  size_t mapLen = 0;
  AlignedBuffer ram;
};

class FrameSlab {
 public:
  FrameSlab() = default;
  ~FrameSlab();
  FrameSlab(const FrameSlab&) = delete;
  FrameSlab& operator=(const FrameSlab&) = delete;

  void SetCacheDir(std::string dir);
  void SetRamThreshold(int64_t bytes);
  int64_t ramThreshold() const { return ramThreshold_; }

  Status Allocate(int width, int height, VideoPixelFormat format, int* slotIndex);
  Status AllocateSparseForTest(int64_t fileOffset, int64_t bytes, int* slotIndex);
  void Pin(int slotIndex);
  void Unpin(int slotIndex);
  SlabSlot* Get(int slotIndex);
  const SlabSlot* Get(int slotIndex) const;
  void FreeUnpinned();
  void Reset();
  int64_t residentBytes() const;
  bool slotIsMmap(int slotIndex) const;
  std::string mmapPath() const { return mmapPath_; }

 private:
  Status MapFileSlot(int64_t offset, int64_t bytes, SlabSlot* slot);
  void Unmap(SlabSlot* slot);

  mutable std::mutex mu_;
  std::vector<std::unique_ptr<SlabSlot>> slots_;
  std::string cacheDir_;
  std::string mmapPath_;
  int mmapFd_ = -1;
  int64_t mmapFileSize_ = 0;
  int64_t ramThreshold_ = 8LL * 1024 * 1024;
  int64_t ramUsed_ = 0;
};

}  // namespace video
}  // namespace sherpa_onnx
