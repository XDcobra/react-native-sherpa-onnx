#pragma once

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <vector>

namespace sherpa_onnx {
namespace video {
namespace preview {

/** SPSC float32 interleaved PCM ring with pts mapping for the write cursor. */
class PcmRing {
 public:
  void Configure(int sampleRate, int channels, int capacityMs = 500) {
    sampleRate_ = sampleRate > 0 ? sampleRate : 48000;
    channels_ = channels > 0 ? channels : 2;
    const int frames =
        static_cast<int>((static_cast<int64_t>(capacityMs) * sampleRate_) /
                         1000);
    capFrames_ = std::max(frames, 1);
    buf_.assign(static_cast<size_t>(capFrames_ * channels_), 0.f);
    r_.store(0);
    w_.store(0);
    ptsUs_.store(0);
    hasPts_.store(false);
  }

  int sampleRate() const { return sampleRate_; }
  int channels() const { return channels_; }
  int capacityFrames() const { return capFrames_; }

  int availableWrite() const {
    const int used =
        (w_.load(std::memory_order_acquire) - r_.load(std::memory_order_acquire) +
         capFrames_) %
        capFrames_;
    return capFrames_ - used - 1;
  }
  int availableRead() const {
    return (w_.load(std::memory_order_acquire) -
            r_.load(std::memory_order_acquire) + capFrames_) %
           capFrames_;
  }

  bool Write(const float* data, int frames, int64_t ptsUs) {
    if (data == nullptr || frames <= 0) return false;
    if (frames > availableWrite()) return false;
    if (!hasPts_.load(std::memory_order_relaxed)) {
      ptsUs_.store(ptsUs, std::memory_order_relaxed);
      hasPts_.store(true, std::memory_order_relaxed);
    }
    const int ch = channels_;
    int w = w_.load(std::memory_order_relaxed);
    for (int i = 0; i < frames; ++i) {
      const int idx = w * ch;
      std::memcpy(&buf_[static_cast<size_t>(idx)], data + i * ch,
                  static_cast<size_t>(ch) * sizeof(float));
      w = (w + 1) % capFrames_;
    }
    w_.store(w, std::memory_order_release);
    return true;
  }

  int Read(float* out, int maxFrames, int64_t* ptsUs) {
    const int n = std::min(maxFrames, availableRead());
    if (n <= 0) return 0;
    if (ptsUs) *ptsUs = ptsUs_.load(std::memory_order_relaxed);
    const int ch = channels_;
    int r = r_.load(std::memory_order_relaxed);
    for (int i = 0; i < n; ++i) {
      const int idx = r * ch;
      std::memcpy(out + i * ch, &buf_[static_cast<size_t>(idx)],
                  static_cast<size_t>(ch) * sizeof(float));
      r = (r + 1) % capFrames_;
    }
    r_.store(r, std::memory_order_release);
    if (sampleRate_ > 0) {
      ptsUs_.fetch_add((static_cast<int64_t>(n) * 1000000LL) / sampleRate_,
                       std::memory_order_relaxed);
    }
    if (availableRead() == 0) {
      hasPts_.store(false, std::memory_order_relaxed);
    }
    return n;
  }

  void Clear() {
    r_.store(0);
    w_.store(0);
    hasPts_.store(false);
    ptsUs_.store(0);
  }

  int64_t writePtsUs() const { return ptsUs_.load(); }

 private:
  std::vector<float> buf_;
  int sampleRate_ = 48000;
  int channels_ = 2;
  int capFrames_ = 1;
  std::atomic<int> r_{0};
  std::atomic<int> w_{0};
  std::atomic<int64_t> ptsUs_{0};
  std::atomic<bool> hasPts_{false};
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
