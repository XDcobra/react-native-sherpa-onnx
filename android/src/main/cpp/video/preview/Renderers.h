#pragma once

#include <cstdint>
#include <functional>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {
namespace preview {

struct VideoRenderStats {
  int64_t rendered = 0;
  int64_t dropped = 0;
  double avOffsetMsMean = 0;
};

class IVideoRenderer {
 public:
  virtual ~IVideoRenderer() = default;
  virtual Status Configure(const VideoTrackInfo& track) = 0;
  virtual Status Submit(const EncodedPacket& pkt, bool displayFlag,
                        uint64_t gen) = 0;
  virtual bool ReadyForMore() const = 0;
  virtual void Flush(uint64_t gen) = 0;
  virtual void SignalEos(uint64_t gen) = 0;
  virtual void Drain(int64_t clockUs, int64_t nowNs, int64_t vsyncNs) {
    (void)clockUs;
    (void)nowNs;
    (void)vsyncNs;
  }
  virtual VideoRenderStats stats() const = 0;
  virtual void Close() = 0;

  std::function<void(uint64_t gen, int64_t ptsUs)> onFirstFrameShown;
  std::function<void(uint64_t gen, int64_t ptsUs)> onFrameShown;
  std::function<void(uint64_t gen)> onEos;
  std::function<void(Status)> onFailed;
};

class IAudioRenderer {
 public:
  virtual ~IAudioRenderer() = default;
  virtual Status Open(int sampleRate, int channels) = 0;
  virtual void Start() = 0;
  virtual void Pause() = 0;
  virtual void Flush(uint64_t gen) = 0;
  virtual void SetVolume(float v) = 0;
  virtual int64_t queuedFrames() const = 0;
  virtual int Write(const float* data, int frames, int64_t ptsUs) = 0;
  virtual void Close() = 0;
  virtual bool Timestamp(int64_t* framePosition, int64_t* nanoTime) {
    (void)framePosition;
    (void)nanoTime;
    return false;
  }
  virtual int64_t HeadPosition() { return 0; }
  virtual int64_t FramesWritten() { return 0; }

  std::function<void(Status)> onFailed;
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
