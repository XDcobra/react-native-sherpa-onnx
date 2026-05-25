#pragma once

#include <string>
#include <cstdint>
#include <vector>

namespace sherpa {

enum class AudioVisualizationAggregateMode {
  MAX_HOLD = 0,
  MEAN = 1,
};

struct AudioVisualizationTimelineConfig {
  bool enabled = false;
  int frameCount = 0;
  double frameDurationMs = 0.0;
  int64_t maxAnalysisSamples = 0;  // 0 = full input.
};

struct AudioVisualizationConfig {
  int sampleRate = 16000;
  int fftSize = 2048;
  int hopSize = 1024;
  int barCount = 96;
  float minHz = 60.0F;
  float maxHz = 0.0F;  // <= 0 => auto choose based on Nyquist.
  AudioVisualizationAggregateMode aggregateMode = AudioVisualizationAggregateMode::MAX_HOLD;
  float silenceRms = 1.0e-5F;
  float minDb = -82.0F;
  float maxDb = -20.0F;
  AudioVisualizationTimelineConfig timeline;
};

struct AudioVisualizationProfile {
  int sampleRate = 0;
  int64_t durationMs = 0;
  int barCount = 0;
  std::vector<float> levels;
  int frameCount = 0;
  double frameDurationMs = 0.0;
  std::vector<float> frames;
};

class AudioVisualizationAccumulator {
 public:
  explicit AudioVisualizationAccumulator(const AudioVisualizationConfig &config);

  void feed(const float *samples, int sampleCount);
  AudioVisualizationProfile finish();

  int sampleRate() const { return sampleRate_; }
  int barCount() const { return barCount_; }
  int64_t totalSamples() const { return totalSamples_; }

 private:
  struct BinRange {
    int start = 1;
    int end = 1;
  };

  void processAvailableFrames();
  void processPaddedFrameIfNeeded();
  void processFrame(const float *frame);
  void ensureWorkBuffers();
  void ensureTimelineBucket(size_t bucketIndex);
  void appendTimelineWindowFrame(int64_t centerSample, const std::vector<float> &barPowers);

  static int nextPowerOfTwo(int value);
  static bool isPowerOfTwo(int value);
  static int hzToBin(double hz, int sampleRate, int fftSize);
  static void fftRadix2(std::vector<double> &re, std::vector<double> &im);
  float powerToUnit(float power) const;

  int sampleRate_;
  int fftSize_;
  int hopSize_;
  int barCount_;
  float minHz_;
  float maxHz_;
  AudioVisualizationAggregateMode aggregateMode_;
  float silenceRms_;
  float minDb_;
  float maxDb_;

  bool timelineEnabled_ = false;
  int timelineFrameCountHint_ = 0;
  double timelineFrameDurationMsHint_ = 0.0;
  int64_t maxAnalysisSamples_ = 0;
  int64_t analyzedSamples_ = 0;
  int64_t frameWindowIndex_ = 0;
  int64_t processedFrameCount_ = 0;

  int64_t totalSamples_ = 0;

  std::vector<float> pending_;
  size_t readOffset_ = 0;

  std::vector<float> window_;
  std::vector<BinRange> barBins_;
  std::vector<float> aggregateLevels_;

  // Timeline-by-duration mode: flattened [frame][bar] max-hold powers.
  std::vector<float> timelineBuckets_;

  // Timeline-by-count mode: keep per-window bar powers for final rebucketing.
  std::vector<int64_t> timelineWindowCenterSamples_;
  std::vector<std::vector<float>> timelineWindowBars_;

  std::vector<double> fftRe_;
  std::vector<double> fftIm_;
};

AudioVisualizationProfile computeAudioVisualizationProfile(
    const float *samples,
    int sampleCount,
    const AudioVisualizationConfig &config);

std::string storeVisualizationFramesForTransfer(std::vector<float> &&frames);
bool takeVisualizationFramesTransfer(
  const std::string &transferId,
  std::vector<float> *outFrames);
void sweepVisualizationFrameTransfers(int64_t maxAgeMs = 60000);

}  // namespace sherpa
