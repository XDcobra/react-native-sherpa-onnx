#pragma once

#include <cstdint>
#include <deque>
#include <vector>

#include "decode/DecoderBackend.h"

namespace sherpa_onnx {
namespace video {

/** Host-only decoder: synthetic packets, real seek/GOP rules. */
class FakeDecoderBackend : public DecoderBackend {
 public:
  static constexpr int kDefaultWidth = 64;
  static constexpr int kDefaultHeight = 48;

  static uint8_t IdentityLuma(int64_t presentationIndex);
  static EncodedPacket MakePacket(int64_t presentationIndex, int64_t ptsUs,
                                  int64_t dtsUs, uint32_t flags, int width = 0,
                                  int height = 0);

  Status Configure(const VideoTrackInfo& track) override;
  Status Submit(const EncodedPacket& packet) override;
  Status Flush() override;
  Status SignalEnd() override;
  bool Receive(DecodedRawFrame* out) override;
  void Close() override;
  int submitCount() const override { return submitCount_; }
  int flushCount() const override { return flushCount_; }
  /** HW decoders only set ptsUs. Tests the DecodeSession PTS→index map. */
  void setOmitPresentationIndex(bool omit) { omitPresentationIndex_ = omit; }
  /** Hold this many packets before emitting (ffmpeg FF_THREAD_FRAME delay). */
  void setEmitDelay(int packets) { emitDelay_ = packets < 0 ? 0 : packets; }

 private:
  Status Emit(int64_t presentationIndex, int64_t ptsUs, int width, int height);
  Status DrainDelayed();

  struct DelayedPacket {
    int64_t presentationIndex = 0;
    int64_t ptsUs = 0;
    int width = 0;
    int height = 0;
  };

  VideoTrackInfo track_;
  bool configured_ = false;
  bool started_ = false;
  bool hasRef_ = false;
  int submitCount_ = 0;
  int flushCount_ = 0;
  int emitDelay_ = 0;
  bool omitPresentationIndex_ = false;
  std::deque<DecodedRawFrame> out_;
  std::deque<DelayedPacket> delayed_;
};

}  // namespace video
}  // namespace sherpa_onnx
