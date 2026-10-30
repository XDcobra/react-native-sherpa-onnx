#pragma once

#include <cstdint>
#include <memory>

#include "VideoEntry.h"
#include "VideoPacketReader.h"
#include "preview/Renderers.h"

namespace sherpa_onnx {
namespace video {
namespace preview {

class VideoFeeder {
 public:
  VideoFeeder(std::shared_ptr<VideoEntry> entry, IVideoRenderer* renderer)
      : reader_(std::move(entry)), renderer_(renderer) {}

  void Start(int64_t tUs, SeekMode mode, uint64_t gen) {
    gen_ = gen;
    eos_ = false;
    if (mode == SeekMode::ClosestKeyframe) {
      // renderer flushes; feeder starts at closest keyframe via SeekToKeyframe
    }
    (void)reader_.SeekToKeyframe(tUs);
    targetUs_ = tUs;
    preroll_ = mode == SeekMode::Accurate;
  }

  void Pump() {
    if (!renderer_ || !renderer_->ReadyForMore() || eos_) return;
    auto pkt = reader_.Next(0);
    if (!pkt.ok()) {
      renderer_->SignalEos(gen_);
      eos_ = true;
      return;
    }
    const bool display = !preroll_ || pkt.value.ptsUs >= targetUs_;
    if (display) preroll_ = false;
    renderer_->Submit(pkt.value, display, gen_);
  }

  void Flush(uint64_t gen) {
    gen_ = gen;
    eos_ = false;
    if (renderer_) renderer_->Flush(gen);
  }

 private:
  VideoPacketReader reader_;
  IVideoRenderer* renderer_ = nullptr;
  uint64_t gen_ = 0;
  int64_t targetUs_ = 0;
  bool preroll_ = false;
  bool eos_ = false;
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
