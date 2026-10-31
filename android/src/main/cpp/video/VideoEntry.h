#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include "VideoTypes.h"
#include "audio/AudioTimeline.h"
#include "codec/CodecArbiter.h"
#include "codec/CodecTypes.h"
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

  void SetDecodePolicy(std::optional<sherpa_onnx::codec::Policy> p);
  std::optional<sherpa_onnx::codec::Policy> decodePolicy() const;
  const sherpa_onnx::codec::Decision& lastDecoderDecision() const {
    return lastDecision_;
  }
  Status lastStickyError() const { return lastStickyError_; }

  std::shared_ptr<DecodeSession> StickySession(
      std::optional<sherpa_onnx::codec::Policy> operation = std::nullopt);
  bool TryMidstreamSoftwareFallback();
  void DropStickySession();
  void OnMemoryPressure(MemoryPressureLevel level);
  void FillCodecInfo(VideoBufferInfo* info) const;

 protected:
  std::string id_;
  VideoKind kind_ = VideoKind::Offline;
  std::atomic<uint64_t> generation_{1};
  std::shared_ptr<DecodedFrameCache> cache_;
  std::shared_ptr<DecodeSession> sticky_;
  std::shared_ptr<DecoderBackend> stickyDecoder_;
  sherpa_onnx::codec::Lease stickyLease_;
  sherpa_onnx::codec::Decision lastDecision_;
  sherpa_onnx::codec::Policy stickyPolicy_ =
      sherpa_onnx::codec::Policy::PreferHardware;
  std::optional<sherpa_onnx::codec::Policy> decodePolicy_;
  Status lastStickyError_;
  bool midstreamUsed_ = false;
  mutable std::mutex mu_;
};

}  // namespace video
}  // namespace sherpa_onnx
