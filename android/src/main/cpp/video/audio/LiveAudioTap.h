#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <thread>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

class VideoEntry;

class LiveAudioTap {
 public:
  using SamplesFn = std::function<void(const float* samples, int n, int sampleRate)>;

  Status Start(std::shared_ptr<VideoEntry> entry, int targetRate, SamplesFn fn);
  void Stop();
  bool running() const { return run_.load(); }

 private:
  void Loop();

  std::shared_ptr<VideoEntry> entry_;
  SamplesFn fn_;
  int targetRate_ = 16000;
  std::atomic<bool> run_{false};
  std::thread th_;
};

}  // namespace video
}  // namespace sherpa_onnx
