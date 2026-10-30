#pragma once

#ifdef __ANDROID__

#include "preview/FrameScheduler.h"
#include "preview/Renderers.h"

#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>
#include <android/native_window.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>

namespace sherpa_onnx {
namespace video {
namespace preview {

class MediaCodecSurfaceRenderer : public IVideoRenderer {
 public:
  MediaCodecSurfaceRenderer();
  ~MediaCodecSurfaceRenderer() override;

  void SetWindow(ANativeWindow* window);
  void SetRefreshHz(double hz);
  int64_t vsyncNs() const { return vsyncNs_.load(); }

  Status Configure(const VideoTrackInfo& track) override;
  Status Submit(const EncodedPacket& pkt, bool displayFlag,
                uint64_t gen) override;
  bool ReadyForMore() const override;
  void Flush(uint64_t gen) override;
  void SignalEos(uint64_t gen) override;
  void Drain(int64_t clockUs, int64_t nowNs, int64_t vsyncNs) override;
  VideoRenderStats stats() const override;
  void Close() override;

 private:
  Status EnsureCodec();

  ANativeWindow* window_ = nullptr;
  AMediaCodec* codec_ = nullptr;
  VideoTrackInfo track_;
  std::string allowedName_;
  uint64_t gen_ = 0;
  bool configured_ = false;
  bool firstShown_ = false;
  bool eosQueued_ = false;
  std::atomic<int64_t> vsyncNs_{16'666'666};
  VideoRenderStats stats_{};
  mutable std::mutex mu_;
  int heldOutput_ = -1;
  int64_t heldPtsUs_ = 0;
  bool heldDisplay_ = true;
  int inputBusy_ = 0;
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx

#endif
