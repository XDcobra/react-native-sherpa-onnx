#pragma once

#include <vector>

#include "core/PacketSource.h"
#include "core/Timeline.h"

namespace sherpa_onnx {
namespace video {

/** In-memory PacketSource (tests + live ring snapshot). Packets are decode-ordered. */
class MemoryPacketSource : public PacketSource {
 public:
  void SetTrack(VideoTrackInfo t) { track_ = std::move(t); }
  void SetPackets(std::vector<EncodedPacket> decodeOrdered) {
    packets_ = std::move(decodeOrdered);
  }
  Timeline* mutableTimeline() { return &timeline_; }
  const Timeline& timeline() const { return timeline_; }

  const VideoTrackInfo& track() const override { return track_; }
  int64_t sampleCount() const override { return timeline_.frameCount(); }
  Status GetSample(int64_t decodeIndex, SampleEntry* out) const override {
    const int64_t p = timeline_.PresentationOfDecode(decodeIndex);
    return timeline_.Get(p, out);
  }
  Status ReadPacket(int64_t decodeIndex, EncodedPacket* out) override {
    if (out == nullptr || decodeIndex < 0 ||
        static_cast<size_t>(decodeIndex) >= packets_.size()) {
      return Status::Fail(kErrFrameOutOfRange, "packet index");
    }
    *out = packets_[static_cast<size_t>(decodeIndex)];
    ++readCount_;
    return Status::Ok();
  }
  int readCount() const { return readCount_; }

 private:
  VideoTrackInfo track_;
  Timeline timeline_;
  std::vector<EncodedPacket> packets_;
  int readCount_ = 0;
};

}  // namespace video
}  // namespace sherpa_onnx
