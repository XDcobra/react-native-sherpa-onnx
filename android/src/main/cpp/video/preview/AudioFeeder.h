#pragma once

#include <algorithm>
#include <cstdint>
#include <memory>

#include "audio/AudioPacketReader.h"
#include "audio/FfmpegAudioDecoder.h"
#include "preview/PcmRing.h"
#include "preview/Renderers.h"

namespace sherpa_onnx {
namespace video {
namespace preview {

class AudioFeeder {
 public:
  AudioFeeder(std::shared_ptr<VideoEntry> entry, IAudioRenderer* renderer)
      : reader_(std::move(entry)), renderer_(renderer) {}

  Status Configure(const AudioTrackInfo& info) {
    auto st = decoder_.Configure(info, 2);
    if (!st.ok) return st;
    ring_.Configure(info.sampleRate, std::min(info.channels, 2));
    if (renderer_) return renderer_->Open(ring_.sampleRate(), ring_.channels());
    return Status::Ok();
  }

  void Start(int64_t tUs, uint64_t gen) {
    gen_ = gen;
    targetUs_ = tUs;
    (void)reader_.SeekTo(tUs);
    decoder_.Flush();
    (void)decoder_.Configure(*reader_.track(), 2);
    ring_.Clear();
  }

  void Pump() {
    if (!renderer_) return;
    while (ring_.availableWrite() > 1024) {
      auto pkt = reader_.Next(0);
      if (!pkt.ok()) {
        EncodedPacket eos;
        decoder_.Submit(eos);
        Drain(true);
        break;
      }
      if (pkt.value.ptsUs + 30000 < targetUs_ && lastPtsUs_ > 0 &&
          pkt.value.ptsUs > lastPtsUs_ + 30000) {
        // gap: pad silence in the ring
      }
      decoder_.Submit(pkt.value);
      Drain(false);
      lastPtsUs_ = pkt.value.ptsUs;
    }
    float tmp[2048];
    int64_t pts = 0;
    const int n = ring_.Read(tmp, 512, &pts);
    if (n > 0) {
      renderer_->Write(tmp, n, pts);
    }
  }

  void Flush(uint64_t gen) {
    gen_ = gen;
    decoder_.Flush();
    ring_.Clear();
    if (renderer_) renderer_->Flush(gen);
  }

  PcmRing& ring() { return ring_; }

 private:
  void Drain(bool) {
    PcmChunk chunk;
    while (decoder_.Receive(&chunk)) {
      int begin = 0;
      if (chunk.ptsUs < targetUs_ && chunk.sampleRate > 0) {
        const int64_t skip = ((targetUs_ - chunk.ptsUs) * chunk.sampleRate) /
                             1000000;
        begin = static_cast<int>(
            std::min<int64_t>(std::max<int64_t>(skip, 0), chunk.frames));
      }
      const int keep = chunk.frames - begin;
      if (keep > 0) {
        ring_.Write(chunk.data + begin * chunk.channels, keep,
                    chunk.ptsUs +
                        (static_cast<int64_t>(begin) * 1000000) /
                            std::max(chunk.sampleRate, 1));
      }
      decoder_.ReturnChunk(&chunk);
    }
  }

  AudioPacketReader reader_;
  FfmpegAudioDecoder decoder_;
  PcmRing ring_;
  IAudioRenderer* renderer_ = nullptr;
  uint64_t gen_ = 0;
  int64_t targetUs_ = 0;
  int64_t lastPtsUs_ = 0;
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
