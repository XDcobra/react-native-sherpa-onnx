#include "core/FrameSlab.h"

#include "VideoLog.h"
#include "core/FileIo.h"

#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>

namespace sherpa_onnx {
namespace video {
namespace {

int64_t Nv12Bytes(int w, int h, int* yStride, int* uvStride) {
  *yStride = AlignUp(w);
  *uvStride = AlignUp(w);
  return static_cast<int64_t>(*yStride) * h +
         static_cast<int64_t>(*uvStride) * ((h + 1) / 2);
}

int64_t PackedBytes(int w, int h, int bpp, int* stride) {
  *stride = AlignUp(w * bpp);
  return static_cast<int64_t>(*stride) * h;
}

}  // namespace

FrameSlab::~FrameSlab() { Reset(); }

void FrameSlab::SetCacheDir(std::string dir) { cacheDir_ = std::move(dir); }

void FrameSlab::SetRamThreshold(int64_t bytes) { ramThreshold_ = bytes; }

void FrameSlab::Unmap(SlabSlot* slot) {
  if (slot == nullptr) {
    return;
  }
  if (slot->mapAddr != nullptr && slot->mapLen > 0) {
    munmap(slot->mapAddr, slot->mapLen);
    slot->mapAddr = nullptr;
    slot->mapLen = 0;
  }
  slot->ram.Reset();
  slot->plane[0] = slot->plane[1] = slot->plane[2] = nullptr;
}

void FrameSlab::Reset() {
  std::lock_guard<std::mutex> lock(mu_);
  for (auto& s : slots_) {
    Unmap(s.get());
  }
  slots_.clear();
  ramUsed_ = 0;
  if (mmapFd_ >= 0) {
    DefaultFileIo().Close(mmapFd_);
    mmapFd_ = -1;
  }
  if (!mmapPath_.empty()) {
    DefaultFileIo().Unlink(mmapPath_.c_str());
    mmapPath_.clear();
  }
  mmapFileSize_ = 0;
}

Status FrameSlab::MapFileSlot(int64_t offset, int64_t bytes, SlabSlot* slot) {
  if (cacheDir_.empty()) {
    return Status::Fail(kErrSpoolIo, "FrameSlab cache dir unset");
  }
  if (mmapFd_ < 0) {
    mmapPath_ = cacheDir_ + "/vid_slab_tmp.bin";
    mmapFd_ = DefaultFileIo().Open(mmapPath_.c_str(),
                                   O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (mmapFd_ < 0) {
      return Status::Fail(kErrSpoolIo, "open slab mmap");
    }
  }
  const int64_t end = offset + bytes;
  if (end > mmapFileSize_) {
    if (DefaultFileIo().Ftruncate(mmapFd_, end) != 0) {
      return Status::Fail(kErrSpoolIo, "ftruncate slab");
    }
    mmapFileSize_ = end;
  }
  const size_t page = static_cast<size_t>(sysconf(_SC_PAGESIZE));
  const int64_t alignedOff = offset & ~static_cast<int64_t>(page - 1);
  const size_t mapLen =
      static_cast<size_t>(bytes + (offset - alignedOff));
  void* addr = mmap(nullptr, mapLen, PROT_READ | PROT_WRITE, MAP_SHARED,
                    mmapFd_, static_cast<off_t>(alignedOff));
  if (addr == MAP_FAILED) {
    return Status::Fail(kErrSpoolIo, "mmap slab");
  }
  slot->mapAddr = addr;
  slot->mapLen = mapLen;
  slot->mmap = true;
  slot->path = mmapPath_;
  auto* base = static_cast<uint8_t*>(addr) + (offset - alignedOff);
  slot->plane[0] = base;
  return Status::Ok();
}

Status FrameSlab::Allocate(int width, int height, VideoPixelFormat format,
                           int* slotIndex) {
  if (width <= 0 || height <= 0 || slotIndex == nullptr) {
    return Status::Fail(kErrInvalidArgument, "FrameSlab::Allocate");
  }
  auto slot = std::make_unique<SlabSlot>();
  slot->width = width;
  slot->height = height;
  slot->format = format;
  int64_t bytes = 0;
  if (format == VideoPixelFormat::Nv12) {
    bytes = Nv12Bytes(width, height, &slot->stride[0], &slot->stride[1]);
  } else if (format == VideoPixelFormat::Gray8) {
    bytes = PackedBytes(width, height, 1, &slot->stride[0]);
  } else {
    bytes = PackedBytes(width, height, 3, &slot->stride[0]);
  }
  slot->bytes = bytes;

  std::lock_guard<std::mutex> lock(mu_);
  const bool useMmap = ramUsed_ + bytes > ramThreshold_ && !cacheDir_.empty();
  if (useMmap) {
    auto st = MapFileSlot(mmapFileSize_, bytes, slot.get());
    if (!st.ok) {
      return st;
    }
    if (format == VideoPixelFormat::Nv12) {
      slot->plane[1] = slot->plane[0] +
                       static_cast<size_t>(slot->stride[0]) * height;
    }
  } else {
    auto st = slot->ram.Allocate(static_cast<size_t>(bytes));
    if (!st.ok) {
      return st;
    }
    slot->plane[0] = slot->ram.data();
    if (format == VideoPixelFormat::Nv12) {
      slot->plane[1] =
          slot->plane[0] + static_cast<size_t>(slot->stride[0]) * height;
    }
    ramUsed_ += bytes;
  }
  if (reinterpret_cast<uintptr_t>(slot->plane[0]) % kAlignBytes != 0) {
    VIDEO_LOGW("slab pointer not 64-aligned");
  }
  slots_.push_back(std::move(slot));
  *slotIndex = static_cast<int>(slots_.size() - 1);
  return Status::Ok();
}

Status FrameSlab::AllocateSparseForTest(int64_t fileOffset, int64_t bytes,
                                        int* slotIndex) {
  auto slot = std::make_unique<SlabSlot>();
  slot->bytes = bytes;
  slot->width = 1;
  slot->height = 1;
  std::lock_guard<std::mutex> lock(mu_);
  auto st = MapFileSlot(fileOffset, bytes, slot.get());
  if (!st.ok) {
    return st;
  }
  slots_.push_back(std::move(slot));
  *slotIndex = static_cast<int>(slots_.size() - 1);
  return Status::Ok();
}

void FrameSlab::Pin(int slotIndex) {
  std::lock_guard<std::mutex> lock(mu_);
  if (slotIndex >= 0 && static_cast<size_t>(slotIndex) < slots_.size() &&
      slots_[static_cast<size_t>(slotIndex)]) {
    slots_[static_cast<size_t>(slotIndex)]->pins++;
  }
}

void FrameSlab::Unpin(int slotIndex) {
  std::lock_guard<std::mutex> lock(mu_);
  if (slotIndex >= 0 && static_cast<size_t>(slotIndex) < slots_.size() &&
      slots_[static_cast<size_t>(slotIndex)]) {
    auto& p = slots_[static_cast<size_t>(slotIndex)]->pins;
    if (p > 0) {
      --p;
    }
  }
}

SlabSlot* FrameSlab::Get(int slotIndex) {
  if (slotIndex < 0 || static_cast<size_t>(slotIndex) >= slots_.size()) {
    return nullptr;
  }
  return slots_[static_cast<size_t>(slotIndex)].get();
}

const SlabSlot* FrameSlab::Get(int slotIndex) const {
  if (slotIndex < 0 || static_cast<size_t>(slotIndex) >= slots_.size()) {
    return nullptr;
  }
  return slots_[static_cast<size_t>(slotIndex)].get();
}

void FrameSlab::FreeUnpinned() {
  std::lock_guard<std::mutex> lock(mu_);
  for (auto& s : slots_) {
    if (!s || s->pins > 0) {
      continue;
    }
    if (!s->mmap) {
      ramUsed_ = std::max<int64_t>(0, ramUsed_ - s->bytes);
    }
    Unmap(s.get());
    s.reset();
  }
}

int64_t FrameSlab::residentBytes() const {
  std::lock_guard<std::mutex> lock(mu_);
  return ramUsed_;
}

bool FrameSlab::slotIsMmap(int slotIndex) const {
  auto* s = Get(slotIndex);
  return s != nullptr && s->mmap;
}

}  // namespace video
}  // namespace sherpa_onnx
