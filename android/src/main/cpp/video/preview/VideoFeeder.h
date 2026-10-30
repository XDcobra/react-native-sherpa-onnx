#pragma once

#include <cstdint>
#include <memory>
#include <optional>

#include "VideoEntry.h"
#include "VideoLog.h"
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
    pending_.reset();
    (void)reader_.SeekToKeyframe(tUs);
    targetUs_ = tUs;
    preroll_ = mode == SeekMode::Accurate;
  }

  void Pump() {
    if (!renderer_ || eos_) return;
    if (!renderer_->ReadyForMore()) {
      return;
    }
    if (!pending_) {
      auto pkt = reader_.Next(0);
      if (!pkt.ok()) {
        renderer_->SignalEos(gen_);
        eos_ = true;
        return;
      }
      pending_ = std::move(pkt.value);
    }
    const EncodedPacket& pkt = *pending_;
    const bool display = !preroll_ || pkt.ptsUs >= targetUs_;
    auto st = renderer_->Submit(pkt, display, gen_);
    if (!st.ok) {
      if (st.errorCode == kErrTryAgain) {
        return;
      }
      VIDEO_LOGW("video.preview.feed submit_fail ptsUs=%lld gen=%llu code=%s msg=%s",
                 static_cast<long long>(pkt.ptsUs),
                 static_cast<unsigned long long>(gen_), st.errorCode.c_str(),
                 st.errorMessage.c_str());
      pending_.reset();
      return;
    }
    if (display) preroll_ = false;
    pending_.reset();
  }

  void Flush(uint64_t gen) {
    gen_ = gen;
    eos_ = false;
    pending_.reset();
    if (renderer_) renderer_->Flush(gen);
  }

 private:
  VideoPacketReader reader_;
  IVideoRenderer* renderer_ = nullptr;
  uint64_t gen_ = 0;
  int64_t targetUs_ = 0;
  bool preroll_ = false;
  bool eos_ = false;
  std::optional<EncodedPacket> pending_;
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
