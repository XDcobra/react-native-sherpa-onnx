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
  int64_t FramesWritten() override { return written_; }
  void Close() override;
  /**
   * Drives `layer` (AVSampleBufferDisplayLayer) from this audio clock. Without
   * it the layer has no timebase and shows every frame as soon as it is
   * decoded (video races ahead, then freezes while the clock keeps running).
   * Replaces a previously attached layer.
   */
  void AttachVideoLayer(void* layer);

 private:
  void* renderer_ = nullptr;
  void* synchronizer_ = nullptr;
  void* attachedVideoRenderer_ = nullptr;  // retained sampleBufferRenderer
  const void* formatDesc_ = nullptr;  // CMAudioFormatDescriptionRef
  int sampleRate_ = 0;
  int channels_ = 0;
  int64_t queued_ = 0;
  int64_t written_ = 0;
};

class SynchronizerClock : public IPlaybackClock {
 public:
  /** Retains `synchronizer` (it must outlive the audio renderer that created it). */
  explicit SynchronizerClock(void* synchronizer);
  ~SynchronizerClock() override;
  SynchronizerClock(const SynchronizerClock&) = delete;
  SynchronizerClock& operator=(const SynchronizerClock&) = delete;
  int64_t NowMediaUs() override;
  void SetRate(double rate, int64_t atMediaUs) override;
  bool audioMastered() const override { return true; }

 private:
  void* synchronizer_ = nullptr;
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
