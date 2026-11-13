#pragma once

#include "preview/Renderers.h"
#include "decode/DecoderBackend.h"

#include <memory>

#ifdef __OBJC__
@class AVSampleBufferDisplayLayer;
#endif

namespace sherpa_onnx {
namespace video {
namespace preview {

/** SW-tier preview: selected DecoderBackend → NV12 CVPixelBuffer → layer. */
class DecodedSampleBufferRenderer : public IVideoRenderer {
 public:
  DecodedSampleBufferRenderer();
  ~DecodedSampleBufferRenderer() override;
  void SetLayer(void* layer);
  void SetDecoder(std::shared_ptr<DecoderBackend> decoder);
  Status Configure(const VideoTrackInfo& track) override;
  Status Submit(const EncodedPacket& pkt, bool displayFlag,
                uint64_t gen) override;
  bool ReadyForMore() const override;
  void Flush(uint64_t gen) override;
  void SignalEos(uint64_t gen) override;
  /** Reports EOS once the clock reached the last queued frame (not on queue). */
  void Drain(int64_t clockUs, int64_t nowNs, int64_t vsyncNs) override;
  VideoRenderStats stats() const override { return stats_; }
  void Close() override;

 private:
  Status EnqueueFrame(const DecodedRawFrame& fr);

  void* layer_ = nullptr;
  void* pool_ = nullptr;  // CVPixelBufferPoolRef
  std::shared_ptr<DecoderBackend> decoder_;
  VideoTrackInfo track_;
  uint64_t gen_ = 0;
  bool firstShown_ = false;
  VideoRenderStats stats_{};
  // EOS waits until the clock has shown the last queued frame.
  int64_t lastQueuedPtsUs_ = 0;
  bool eosPending_ = false;
  uint64_t eosGen_ = 0;
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
