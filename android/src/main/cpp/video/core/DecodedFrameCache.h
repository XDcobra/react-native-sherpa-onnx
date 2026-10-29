#pragma once

#include <cstdint>
#include <list>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>

#include "VideoTypes.h"
#include "core/ColorConvert.h"
#include "core/FrameLease.h"
#include "core/FrameSlab.h"

namespace sherpa_onnx {
namespace video {

struct CacheKey {
  int64_t presentationIndex = -1;
  int maxSideBucket = 0;
  VideoPixelFormat format = VideoPixelFormat::Nv12;
  bool applyTransform = true;
  bool packed = false;

  bool operator==(const CacheKey& o) const {
    return presentationIndex == o.presentationIndex &&
           maxSideBucket == o.maxSideBucket && format == o.format &&
           applyTransform == o.applyTransform && packed == o.packed;
  }
};

struct CacheKeyHash {
  size_t operator()(const CacheKey& k) const {
    size_t h = std::hash<int64_t>{}(k.presentationIndex);
    h ^= std::hash<int>{}(k.maxSideBucket) + 0x9e3779b9 + (h << 6) + (h >> 2);
    h ^= std::hash<int>{}(static_cast<int>(k.format)) + 0x9e3779b9 + (h << 6) +
         (h >> 2);
    return h;
  }
};

class DecodedFrameCache : public std::enable_shared_from_this<DecodedFrameCache> {
 public:
  DecodedFrameCache();
  ~DecodedFrameCache();

  void SetCacheDir(const std::string& dir);
  void SetRamThreshold(int64_t bytes);

  Result<VideoFrameLease> Lookup(const CacheKey& key);
  Status InsertNv12(const CacheKey& key, const Nv12View& src, int64_t ptsUs,
                    const VideoTrackInfo& track);
  Status InsertView(const CacheKey& key, const VideoFrameView& view,
                    int64_t ptsUs);

  Result<VideoFrameLease> Pin(const CacheKey& key);
  void ShrinkToPinned();
  void ClearUnpinned();
  int64_t residentBytes() const;
  int cachedCount() const;
  int decodeInserts() const { return decodeInserts_; }

  FrameSlab& slab() { return slab_; }
  void UnpinSlot(int slot, int64_t bytes);

 private:
  bool EvictOneUnlocked();
  Result<VideoFrameLease> MakeLeaseUnlocked(const CacheKey& key);

  struct Entry {
    CacheKey key;
    int slot = -1;
    int64_t ptsUs = 0;
    int64_t bytes = 0;
    int pins = 0;
    std::list<CacheKey>::iterator lruIt;
  };

  mutable std::mutex mu_;
  FrameSlab slab_;
  std::unordered_map<CacheKey, Entry, CacheKeyHash> map_;
  std::list<CacheKey> lru_;
  int decodeInserts_ = 0;
};

}  // namespace video
}  // namespace sherpa_onnx
