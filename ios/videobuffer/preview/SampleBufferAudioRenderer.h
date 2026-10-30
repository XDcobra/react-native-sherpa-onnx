#pragma once

#include "preview/PlaybackClock.h"
#include "preview/Renderers.h"

namespace sherpa_onnx {
namespace video {
namespace preview {

class SampleBufferAudioRenderer : public IAudioRenderer {
 public:
  SampleBufferAudioRenderer();
  ~SampleBufferAudioRenderer() override;
  void* renderer() const { return renderer_; }
  void* synchronizer() const { return synchronizer_; }
  Status Open(int sampleRate, int channels) override;
  void Start() override;
  void Pause() override;
  void Flush(uint64_t gen) override;
  void SetVolume(float v) override;
  int64_t queuedFrames() const override { return queued_; }
  int Write(const float* data, int frames, int64_t ptsUs) override;
  void Close() override;
  void AttachVideoLayer(void* layer);

 private:
  void* renderer_ = nullptr;
  void* synchronizer_ = nullptr;
  void* formatDesc_ = nullptr;
  int sampleRate_ = 0;
  int channels_ = 0;
  int64_t queued_ = 0;
  int64_t written_ = 0;
};

class SynchronizerClock : public IPlaybackClock {
 public:
  explicit SynchronizerClock(void* synchronizer);
  int64_t NowMediaUs() override;
  void SetRate(double rate, int64_t atMediaUs) override;
  bool audioMastered() const override { return true; }

 private:
  void* synchronizer_ = nullptr;
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
