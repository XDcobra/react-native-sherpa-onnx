#include "core/DecodedFrameCache.h"

#include "VideoLog.h"
#include "core/MemoryBudget.h"

#include <cstring>

namespace sherpa_onnx {
namespace video {
namespace {

class CacheFramePin : public FramePin {
 public:
  CacheFramePin(std::shared_ptr<DecodedFrameCache> cache, int slot,
                int64_t bytes)
      : cache_(std::move(cache)), slot_(slot), bytes_(bytes) {}
  ~CacheFramePin() override {
    if (cache_) {
      cache_->UnpinSlot(slot_, bytes_);
    }
  }

 private:
  std::shared_ptr<DecodedFrameCache> cache_;
  int slot_ = -1;
  int64_t bytes_ = 0;
};

VideoFrameView ViewFromSlot(const SlabSlot* s, int64_t ptsUs,
                            int64_t frameIndex) {
  VideoFrameView v;
  if (s == nullptr) {
    return v;
  }
  v.plane[0] = s->plane[0];
  v.plane[1] = s->plane[1];
  v.plane[2] = s->plane[2];
  v.stride[0] = s->stride[0];
  v.stride[1] = s->stride[1];
  v.stride[2] = s->stride[2];
  v.width = s->width;
  v.height = s->height;
  v.format = s->format;
  v.ptsUs = ptsUs;
  v.frameIndex = frameIndex;
  return v;
}

}  // namespace

DecodedFrameCache::DecodedFrameCache() = default;

DecodedFrameCache::~DecodedFrameCache() {
  std::lock_guard<std::mutex> lock(mu_);
  for (auto& kv : map_) {
    MemoryBudget::Instance().Release(kv.second.bytes);
  }
  map_.clear();
  lru_.clear();
  slab_.Reset();
}

void DecodedFrameCache::SetCacheDir(const std::string& dir) {
  slab_.SetCacheDir(dir);
}

void DecodedFrameCache::SetRamThreshold(int64_t bytes) {
  slab_.SetRamThreshold(bytes);
}

void DecodedFrameCache::UnpinSlot(int slot, int64_t bytes) {
  std::lock_guard<std::mutex> lock(mu_);
  slab_.Unpin(slot);
  (void)bytes;
  for (auto& kv : map_) {
    if (kv.second.slot == slot && kv.second.pins > 0) {
      kv.second.pins--;
      break;
    }
  }
}

bool DecodedFrameCache::EvictOneUnlocked() {
  for (auto it = lru_.end(); it != lru_.begin();) {
    --it;
    auto mit = map_.find(*it);
    if (mit == map_.end() || mit->second.pins > 0) {
      continue;
    }
    MemoryBudget::Instance().Release(mit->second.bytes);
    map_.erase(mit);
    it = lru_.erase(it);
    slab_.FreeUnpinned();
    return true;
  }
  return false;
}

Result<VideoFrameLease> DecodedFrameCache::MakeLeaseUnlocked(
    const CacheKey& key) {
  Result<VideoFrameLease> r;
  auto it = map_.find(key);
  if (it == map_.end()) {
    r.status = Status::Fail(kErrFrameOutOfRange, "cache miss");
    return r;
  }
  auto* slot = slab_.Get(it->second.slot);
  if (slot == nullptr) {
    r.status = Status::Fail(kErrFrameOutOfRange, "slot gone");
    return r;
  }
  slab_.Pin(it->second.slot);
  it->second.pins++;
  lru_.erase(it->second.lruIt);
  lru_.push_front(key);
  it->second.lruIt = lru_.begin();
  auto pin = std::make_shared<CacheFramePin>(shared_from_this(),
                                             it->second.slot, it->second.bytes);
  r.value = VideoFrameLease(
      ViewFromSlot(slot, it->second.ptsUs, key.presentationIndex),
      std::move(pin));
  return r;
}

Result<VideoFrameLease> DecodedFrameCache::Lookup(const CacheKey& key) {
  std::lock_guard<std::mutex> lock(mu_);
  return MakeLeaseUnlocked(key);
}

bool DecodedFrameCache::Contains(const CacheKey& key) const {
  std::lock_guard<std::mutex> lock(mu_);
  return map_.find(key) != map_.end();
}

Result<VideoFrameLease> DecodedFrameCache::Pin(const CacheKey& key) {
  return Lookup(key);
}

Status DecodedFrameCache::InsertView(const CacheKey& key,
                                     const VideoFrameView& view,
                                     int64_t ptsUs) {
  if (view.plane[0] == nullptr || view.width <= 0 || view.height <= 0) {
    return Status::Fail(kErrInvalidArgument, "InsertView");
  }
  int64_t bytes = 0;
  if (view.format == VideoPixelFormat::Nv12) {
    bytes = static_cast<int64_t>(AlignUp(view.width)) * view.height +
            static_cast<int64_t>(AlignUp(view.width)) * ((view.height + 1) / 2);
  } else if (view.format == VideoPixelFormat::Gray8) {
    bytes = static_cast<int64_t>(AlignUp(view.width)) * view.height;
  } else {
    bytes = static_cast<int64_t>(AlignUp(view.width * 3)) * view.height;
  }

  std::lock_guard<std::mutex> lock(mu_);
  auto existing = map_.find(key);
  if (existing != map_.end()) {
    lru_.erase(existing->second.lruIt);
    lru_.push_front(key);
    existing->second.lruIt = lru_.begin();
    existing->second.ptsUs = ptsUs;
    return Status::Ok();
  }

  while (!MemoryBudget::Instance().TryReserve(bytes)) {
    if (!EvictOneUnlocked()) {
      VIDEO_LOGW("video.cache budget exceeded inserting %lld bytes",
                 static_cast<long long>(bytes));
      return Status::Fail(kErrMemoryBudget, "decoded cache");
    }
  }

  int slotIx = -1;
  auto st = slab_.Allocate(view.width, view.height, view.format, &slotIx);
  if (!st.ok) {
    MemoryBudget::Instance().Release(bytes);
    return st;
  }
  auto* slot = slab_.Get(slotIx);
  if (slot == nullptr || slot->plane[0] == nullptr) {
    MemoryBudget::Instance().Release(bytes);
    return Status::Fail(kErrDecodeFailed, "slab slot");
  }
  if (view.format == VideoPixelFormat::Nv12) {
    for (int row = 0; row < view.height; ++row) {
      std::memcpy(slot->plane[0] + static_cast<size_t>(row) * slot->stride[0],
                  view.plane[0] + static_cast<size_t>(row) * view.stride[0],
                  static_cast<size_t>(view.width));
    }
    const int ch = (view.height + 1) / 2;
    for (int row = 0; row < ch; ++row) {
      std::memcpy(slot->plane[1] + static_cast<size_t>(row) * slot->stride[1],
                  view.plane[1] + static_cast<size_t>(row) * view.stride[1],
                  static_cast<size_t>(view.width));
    }
  } else {
    const int bpp = view.format == VideoPixelFormat::Rgb24 ? 3 : 1;
    for (int row = 0; row < view.height; ++row) {
      const int n = view.width * bpp;
      std::memcpy(slot->plane[0] + static_cast<size_t>(row) * slot->stride[0],
                  view.plane[0] + static_cast<size_t>(row) * view.stride[0],
                  static_cast<size_t>(n));
    }
  }

  Entry e;
  e.key = key;
  e.slot = slotIx;
  e.ptsUs = ptsUs;
  e.bytes = bytes;
  lru_.push_front(key);
  e.lruIt = lru_.begin();
  map_.emplace(key, e);
  ++decodeInserts_;
  VIDEO_LOGD("video.cache insert idx=%lld bytes=%lld count=%zu",
             static_cast<long long>(key.presentationIndex),
             static_cast<long long>(bytes), map_.size());
  return Status::Ok();
}

Status DecodedFrameCache::InsertNv12(const CacheKey& key, const Nv12View& src,
                                     int64_t ptsUs,
                                     const VideoTrackInfo& track) {
  VideoFrameView v;
  v.plane[0] = src.y.data;
  v.plane[1] = src.uv.data;
  v.stride[0] = src.y.stride;
  v.stride[1] = src.uv.stride;
  v.width = src.width;
  v.height = src.height;
  v.format = VideoPixelFormat::Nv12;
  v.ptsUs = ptsUs;
  v.frameIndex = key.presentationIndex;
  (void)track;
  return InsertView(key, v, ptsUs);
}

void DecodedFrameCache::ShrinkToPinned() {
  std::lock_guard<std::mutex> lock(mu_);
  while (EvictOneUnlocked()) {
  }
}

void DecodedFrameCache::ClearUnpinned() { ShrinkToPinned(); }

int64_t DecodedFrameCache::residentBytes() const {
  std::lock_guard<std::mutex> lock(mu_);
  int64_t n = 0;
  for (const auto& kv : map_) {
    n += kv.second.bytes;
  }
  return n;
}

int DecodedFrameCache::cachedCount() const {
  std::lock_guard<std::mutex> lock(mu_);
  return static_cast<int>(map_.size());
}

}  // namespace video
}  // namespace sherpa_onnx
