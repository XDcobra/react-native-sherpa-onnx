#pragma once

#include <atomic>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "VideoEntry.h"
#include "core/PacketSource.h"
#include "live/AudioPacketRing.h"
#include "live/EncodedPacketRing.h"
#include "live/PacketSpool.h"

namespace sherpa_onnx {
namespace video {

struct LiveVideoOptions {
  int64_t ringSeconds = 10;
  int64_t ringMaxBytes = 0;  // 0 = ram-class default
  SpoolOptions spool;
};

class LiveVideoEntry : public VideoEntry, public PacketSource {
 public:
  static std::shared_ptr<LiveVideoEntry> Create(const LiveVideoOptions& opts,
                                                const std::string& cacheDir);

  Status SetCodecConfig(VideoCodec codec, std::vector<uint8_t> config,
                        const VideoTrackInfo& track);
  Status SetAudioConfig(const AudioTrackInfo& audio);
  Status AppendPacket(const EncodedPacket& pkt);
  Status AppendAudioPacket(const EncodedPacket& pkt);
  Status Finish();

  VideoBufferInfo Info() const override;
  PacketSource* packets() override { return this; }
  const Timeline* timeline() const override { return &timeline_; }
  std::shared_ptr<DecodedFrameCache> cache() override { return cache_; }
  VideoBufferState state() const override { return state_; }

  const AudioTrackInfo* audioTrack() const override {
    return audio_ ? &*audio_ : nullptr;
  }
  const AudioTimeline* audioTimeline() const override {
    return audio_ ? &audioTimeline_ : nullptr;
  }
  Status ReadAudioPacket(int64_t index, EncodedPacket* out) override;

  const VideoTrackInfo& track() const override { return track_; }
  int64_t sampleCount() const override { return timeline_.frameCount(); }
  Status GetSample(int64_t decodeIndex, SampleEntry* out) const override;
  Status ReadPacket(int64_t decodeIndex, EncodedPacket* out) override;

  bool isFinished() const { return state_ == VideoBufferState::Finished; }
  EncodedPacketRing& ring() { return ring_; }
  PacketSpool& spool() { return spool_; }
  Timeline& mutableTimeline() { return timeline_; }

  void WaitAppend(int timeoutMs);
  void NotifyReaders();

  using EventFn = std::function<void(const std::string& type)>;
  void SetEventFn(EventFn fn) { eventFn_ = std::move(fn); }

 private:
  LiveVideoOptions opts_;
  std::string cacheDir_;
  VideoTrackInfo track_;
  std::optional<AudioTrackInfo> audio_;
  AudioTimeline audioTimeline_;
  AudioPacketRing audioRing_;
  uint64_t appendGen_ = 0;
  Timeline timeline_;
  EncodedPacketRing ring_;
  PacketSpool spool_;
  VideoBufferState state_ = VideoBufferState::Recording;
  bool codecSet_ = false;
  EventFn eventFn_;
  std::condition_variable cv_;
};

}  // namespace video
}  // namespace sherpa_onnx
