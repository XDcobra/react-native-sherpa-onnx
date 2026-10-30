#pragma once

#include <cstdint>

namespace sherpa_onnx {
namespace video {
namespace preview {

class IPlaybackClock {
 public:
  virtual ~IPlaybackClock() = default;
  virtual int64_t NowMediaUs() = 0;
  virtual void SetRate(double rate, int64_t atMediaUs) = 0;
  virtual bool audioMastered() const = 0;
};

class MonotonicClock : public IPlaybackClock {
 public:
  void SetNowNsForTest(int64_t ns) { nowNsOverride_ = ns; }
  int64_t NowMediaUs() override;
  void SetRate(double rate, int64_t atMediaUs) override;
  bool audioMastered() const override { return false; }

 private:
  int64_t NowNs() const;
  int64_t anchorMediaUs_ = 0;
  int64_t anchorNs_ = 0;
  double rate_ = 0;
  int64_t nowNsOverride_ = -1;
};

struct AudioClockEstimator {
  int64_t anchorPtsUs = 0;
  int64_t anchorFrame = 0;
  int64_t framesWritten = 0;
  int64_t tsFrame = -1;
  int64_t tsNanoTime = 0;
  int sampleRate = 48000;
  double rate = 0;
  int64_t lastMediaUs = 0;
  bool haveTs = false;

  void ResetSegment(int64_t ptsUs, int64_t writtenAtStart);
  void OnTimestamp(int64_t framePosition, int64_t nanoTime);
  void OnHead(int64_t playbackHeadFrames);
  int64_t Media(int64_t nowNs, int64_t* correctionUs = nullptr) const;
  int64_t ApplyGuards(int64_t candidateUs, int64_t nowNs, bool* snapped);
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
