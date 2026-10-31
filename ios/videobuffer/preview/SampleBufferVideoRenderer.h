#pragma once

#include "preview/Renderers.h"

#ifdef __OBJC__
@class AVSampleBufferDisplayLayer;
#endif

namespace sherpa_onnx {
namespace video {
namespace preview {

class SampleBufferVideoRenderer : public IVideoRenderer {
 public:
  SampleBufferVideoRenderer();
  ~SampleBufferVideoRenderer() override;
  void SetLayer(void* layer);
  Status Configure(const VideoTrackInfo& track) override;
  Status Submit(const EncodedPacket& pkt, bool displayFlag,
                uint64_t gen) override;
  bool ReadyForMore() const override;
  void Flush(uint64_t gen) override;
  void SignalEos(uint64_t gen) override;
  VideoRenderStats stats() const override { return stats_; }
  void Close() override;

 private:
  void* layer_ = nullptr;
  const void* formatDesc_ = nullptr;  // CMVideoFormatDescriptionRef
  VideoTrackInfo track_;
  uint64_t gen_ = 0;
  bool firstShown_ = false;
  VideoRenderStats stats_{};
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
