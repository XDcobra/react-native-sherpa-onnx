#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>

#include "VideoTypes.h"
#include "audio/AudioTimeline.h"
#include "core/DecodedFrameCache.h"
#include "core/PacketSource.h"
#include "core/Timeline.h"
#include "decode/DecodeSession.h"
#include "decode/DecoderPool.h"

namespace sherpa_onnx {
namespace video {

class VideoEntry {
 public:
  virtual ~VideoEntry() = default;

  const std::string& id() const { return id_; }
  VideoKind kind() const { return kind_; }
  uint64_t generation() const { return generation_.load(); }
  void BumpGeneration() { generation_.fetch_add(1); }

  virtual VideoBufferInfo Info() const = 0;
  virtual PacketSource* packets() = 0;
  virtual const Timeline* timeline() const = 0;
  virtual std::shared_ptr<DecodedFrameCache> cache() = 0;
  virtual VideoBufferState state() const = 0;
  virtual const AudioTrackInfo* audioTrack() const { return nullptr; }
  virtual const AudioTimeline* audioTimeline() const { return nullptr; }
  virtual Status ReadAudioPacket(int64_t index, EncodedPacket* out);

  std::shared_ptr<DecodeSession> StickySession();
  void DropStickySession();
  void OnMemoryPressure(MemoryPressureLevel level);

 protected:
  std::string id_;
  VideoKind kind_ = VideoKind::Offline;
  std::atomic<uint64_t> generation_{1};
  std::shared_ptr<DecodedFrameCache> cache_;
  std::shared_ptr<DecodeSession> sticky_;
  std::shared_ptr<DecoderBackend> stickyDecoder_;
  mutable std::mutex mu_;
};

}  // namespace video
}  // namespace sherpa_onnx
