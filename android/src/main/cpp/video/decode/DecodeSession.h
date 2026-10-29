#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "core/DecodedFrameCache.h"
#include "core/PacketSource.h"
#include "core/Timeline.h"
#include "decode/DecoderBackend.h"

namespace sherpa_onnx {
namespace video {

class DecodeSession {
 public:
  DecodeSession(std::string bufferId, PacketSource* source,
                const Timeline* timeline,
                std::shared_ptr<DecodedFrameCache> cache,
                std::shared_ptr<DecoderBackend> decoder);

  void SetGenerationSource(std::function<uint64_t()> fn);
  void SetTrack(const VideoTrackInfo& track) { track_ = track; }

  Result<VideoFrameLease> SeekAndAcquire(const FrameRequest& req);

  Status Flush();
  int64_t lastDecodeIndex() const { return lastDecodeIndex_; }
  int flushCount() const;
  int submitCount() const;
  bool sameGopReuse() const { return sameGopReuse_; }

 private:
  Status EnsureConfigured();
  Status SeekToKeyframe(int64_t keyPres);
  Status DecodeThrough(int64_t targetPres, bool cacheAlongWay);
  Status DrainToCache(bool cacheAlongWay, int64_t targetPres);
  CacheKey Nv12Key(int64_t pres, const FrameRequest& req) const;
  Status MaybeConvert(const VideoFrameLease& nv12, const FrameRequest& req,
                      VideoFrameLease* out);

  std::string bufferId_;
  PacketSource* source_ = nullptr;
  const Timeline* timeline_ = nullptr;
  std::shared_ptr<DecodedFrameCache> cache_;
  std::shared_ptr<DecoderBackend> decoder_;
  VideoTrackInfo track_;
  std::function<uint64_t()> generationFn_;
  uint64_t generationAtStart_ = 0;
  int64_t lastDecodeIndex_ = -1;
  int64_t lastKeyframePres_ = -1;
  bool configured_ = false;
  bool sameGopReuse_ = false;
};

}  // namespace video
}  // namespace sherpa_onnx
