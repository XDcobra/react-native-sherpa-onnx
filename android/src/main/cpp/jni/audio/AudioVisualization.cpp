#include "AudioVisualization.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>

namespace sherpa {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr int kMinFrameCount = 8;
constexpr int kMaxFrameCount = 512;
constexpr double kMinFrameDurationMs = 50.0;
constexpr double kMaxFrameDurationMs = 10000.0;
constexpr int64_t kMaxFramePayloadFloats = 131072;
constexpr double kDefaultFrameDurationMs = 500.0;

int clampInt(int value, int minValue, int maxValue) {
  return std::max(minValue, std::min(maxValue, value));
}

float clampFloat(float value, float minValue, float maxValue) {
  return std::max(minValue, std::min(maxValue, value));
}

int64_t nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

struct VisualizationTransferEntry {
  std::vector<float> frames;
  int64_t createdAtMs = 0;
};

std::mutex gVisualizationTransferMutex;
std::unordered_map<std::string, VisualizationTransferEntry>
    gVisualizationTransferStore;
std::atomic<uint64_t> gVisualizationTransferCounter{1};

}  // namespace

AudioVisualizationAccumulator::AudioVisualizationAccumulator(
    const AudioVisualizationConfig &config)
    : sampleRate_(std::max(1, config.sampleRate)),
      fftSize_(config.fftSize),
      hopSize_(config.hopSize),
      barCount_(clampInt(config.barCount, 1, 1024)),
      minHz_(std::max(10.0F, config.minHz)),
      maxHz_(config.maxHz),
      aggregateMode_(config.aggregateMode),
      silenceRms_(std::max(0.0F, config.silenceRms)),
      minDb_(config.minDb),
      maxDb_(std::max(config.minDb + 1.0F, config.maxDb)),
      timelineEnabled_(
          config.timeline.enabled || config.timeline.frameCount > 0 ||
          config.timeline.frameDurationMs > 0.0),
      timelineFrameCountHint_(config.timeline.frameCount),
      timelineFrameDurationMsHint_(config.timeline.frameDurationMs),
      maxAnalysisSamples_(std::max<int64_t>(0, config.timeline.maxAnalysisSamples)) {
  if (fftSize_ < 256) {
    fftSize_ = 256;
  }
  if (!isPowerOfTwo(fftSize_)) {
    fftSize_ = nextPowerOfTwo(fftSize_);
  }
  fftSize_ = clampInt(fftSize_, 256, 16384);

  hopSize_ = clampInt(hopSize_, 1, fftSize_);

  const float nyquist = static_cast<float>(sampleRate_) * 0.5F;
  const float autoMaxHz = std::min(8000.0F, nyquist * 0.98F);
  if (maxHz_ <= minHz_) {
    maxHz_ = std::max(minHz_ + 1.0F, autoMaxHz);
  }
  maxHz_ = std::min(maxHz_, nyquist > 1.0F ? nyquist - 1.0F : maxHz_);
  if (maxHz_ <= minHz_) {
    maxHz_ = minHz_ + 1.0F;
  }

  window_.resize(static_cast<size_t>(fftSize_));
  if (fftSize_ <= 1) {
    std::fill(window_.begin(), window_.end(), 1.0F);
  } else {
    for (int i = 0; i < fftSize_; ++i) {
      window_[static_cast<size_t>(i)] = static_cast<float>(
          0.5 * (1.0 - std::cos((2.0 * kPi * i) / (fftSize_ - 1))));
    }
  }

  const double logMinHz = std::log(static_cast<double>(minHz_));
  const double logMaxHz = std::log(static_cast<double>(maxHz_));
  const double step = (logMaxHz - logMinHz) / static_cast<double>(barCount_);

  barBins_.reserve(static_cast<size_t>(barCount_));
  for (int i = 0; i < barCount_; ++i) {
    const double loHz = std::exp(logMinHz + step * static_cast<double>(i));
    const double hiHz = std::exp(logMinHz + step * static_cast<double>(i + 1));

    int start = hzToBin(loHz, sampleRate_, fftSize_);
    int end = hzToBin(hiHz, sampleRate_, fftSize_);
    if (end < start) {
      end = start;
    }

    barBins_.push_back(BinRange{start, end});
  }

  aggregateLevels_.assign(static_cast<size_t>(barCount_), 0.0F);

  if (!timelineEnabled_) {
    timelineFrameCountHint_ = 0;
    timelineFrameDurationMsHint_ = 0.0;
    return;
  }

  if (timelineFrameCountHint_ > 0) {
    if (timelineFrameCountHint_ < kMinFrameCount ||
        timelineFrameCountHint_ > kMaxFrameCount) {
      throw std::runtime_error(
          "AUDIO_VISUALIZATION_INVALID_OPTIONS: frameCount must be between 8 and 512");
    }
    if (static_cast<int64_t>(timelineFrameCountHint_) *
            static_cast<int64_t>(barCount_) >
        kMaxFramePayloadFloats) {
      throw std::runtime_error(
          "AUDIO_VISUALIZATION_PAYLOAD_TOO_LARGE: frameCount * barCount exceeds 131072");
    }
    timelineFrameDurationMsHint_ = 0.0;
  } else {
    if (timelineFrameDurationMsHint_ <= 0.0) {
      timelineFrameDurationMsHint_ = kDefaultFrameDurationMs;
    }
    if (timelineFrameDurationMsHint_ < kMinFrameDurationMs ||
        timelineFrameDurationMsHint_ > kMaxFrameDurationMs) {
      throw std::runtime_error(
          "AUDIO_VISUALIZATION_INVALID_OPTIONS: frameDurationMs must be between 50 and 10000");
    }
  }
}

void AudioVisualizationAccumulator::feed(const float *samples, int sampleCount) {
  if (samples == nullptr || sampleCount <= 0) {
    return;
  }

  int count = sampleCount;
  if (maxAnalysisSamples_ > 0) {
    const int64_t remaining = maxAnalysisSamples_ - analyzedSamples_;
    if (remaining <= 0) {
      return;
    }
    if (remaining < count) {
      count = static_cast<int>(remaining);
    }
  }

  if (count <= 0) {
    return;
  }

  analyzedSamples_ += static_cast<int64_t>(count);
  totalSamples_ = analyzedSamples_;
  pending_.insert(
      pending_.end(),
      samples,
      samples + static_cast<size_t>(count));

  processAvailableFrames();
}

AudioVisualizationProfile AudioVisualizationAccumulator::finish() {
  processAvailableFrames();
  processPaddedFrameIfNeeded();

  std::vector<float> levels(static_cast<size_t>(barCount_), 0.0F);
  if (processedFrameCount_ > 0) {
    for (int i = 0; i < barCount_; ++i) {
      float power = aggregateLevels_[static_cast<size_t>(i)];
      if (aggregateMode_ == AudioVisualizationAggregateMode::MEAN) {
        power /= static_cast<float>(processedFrameCount_);
      }
      levels[static_cast<size_t>(i)] = powerToUnit(power);
    }
  }

  AudioVisualizationProfile profile;
  profile.sampleRate = sampleRate_;
  profile.durationMs =
      static_cast<int64_t>((totalSamples_ * 1000LL) / std::max(1, sampleRate_));
  profile.barCount = barCount_;
  profile.levels = std::move(levels);

  if (!timelineEnabled_) {
    return profile;
  }

  int resolvedFrameCount = 0;
  double resolvedFrameDurationMs = 0.0;

  if (timelineFrameCountHint_ > 0) {
    resolvedFrameCount = timelineFrameCountHint_;
    if (resolvedFrameCount > 0) {
      resolvedFrameDurationMs = profile.durationMs > 0
          ? static_cast<double>(profile.durationMs) /
              static_cast<double>(resolvedFrameCount)
          : kDefaultFrameDurationMs;
    }
  } else {
    resolvedFrameDurationMs =
        timelineFrameDurationMsHint_ > 0.0
            ? timelineFrameDurationMsHint_
            : kDefaultFrameDurationMs;
    if (profile.durationMs > 0) {
      resolvedFrameCount = static_cast<int>(
          std::ceil(static_cast<double>(profile.durationMs) /
                    resolvedFrameDurationMs));
    }
  }

  if (resolvedFrameCount <= 0) {
    profile.frameCount = 0;
    profile.frameDurationMs = 0.0;
    return profile;
  }

  if (resolvedFrameCount < kMinFrameCount || resolvedFrameCount > kMaxFrameCount) {
    throw std::runtime_error(
        "AUDIO_VISUALIZATION_INVALID_OPTIONS: resolved frameCount must be between 8 and 512");
  }

  if (static_cast<int64_t>(resolvedFrameCount) *
          static_cast<int64_t>(barCount_) >
      kMaxFramePayloadFloats) {
    throw std::runtime_error(
        "AUDIO_VISUALIZATION_PAYLOAD_TOO_LARGE: frameCount * barCount exceeds 131072");
  }

  profile.frameCount = resolvedFrameCount;
  profile.frameDurationMs = resolvedFrameDurationMs;
  profile.frames.assign(
      static_cast<size_t>(resolvedFrameCount * barCount_),
      0.0F);

  if (timelineFrameCountHint_ > 0) {
    const int64_t totalForBucketing = std::max<int64_t>(1, totalSamples_);
    for (size_t i = 0; i < timelineWindowCenterSamples_.size(); ++i) {
      if (i >= timelineWindowBars_.size()) {
        break;
      }
      const int64_t centerSample = timelineWindowCenterSamples_[i];
      const int bucket = std::min(
          resolvedFrameCount - 1,
          std::max(
              0,
              static_cast<int>((centerSample * resolvedFrameCount) /
                               totalForBucketing)));
      float *dst =
          profile.frames.data() + static_cast<size_t>(bucket * barCount_);
      const std::vector<float> &src = timelineWindowBars_[i];
      const int n = std::min(static_cast<int>(src.size()), barCount_);
      for (int b = 0; b < n; ++b) {
        dst[b] = std::max(dst[b], src[static_cast<size_t>(b)]);
      }
    }
  } else {
    const int availableBuckets = static_cast<int>(timelineBuckets_.size() /
                                                  static_cast<size_t>(barCount_));
    const int bucketsToCopy = std::min(availableBuckets, resolvedFrameCount);
    for (int t = 0; t < bucketsToCopy; ++t) {
      const float *src = timelineBuckets_.data() + static_cast<size_t>(t * barCount_);
      float *dst = profile.frames.data() + static_cast<size_t>(t * barCount_);
      for (int b = 0; b < barCount_; ++b) {
        dst[b] = std::max(dst[b], src[b]);
      }
    }
  }

  for (float &power : profile.frames) {
    power = powerToUnit(power);
  }

  return profile;
}

void AudioVisualizationAccumulator::processAvailableFrames() {
  while (pending_.size() >= readOffset_ + static_cast<size_t>(fftSize_)) {
    processFrame(pending_.data() + readOffset_);
    readOffset_ += static_cast<size_t>(hopSize_);

    if (readOffset_ >= static_cast<size_t>(fftSize_ * 8)) {
      pending_.erase(pending_.begin(), pending_.begin() + static_cast<long>(readOffset_));
      readOffset_ = 0;
    }
  }
}

void AudioVisualizationAccumulator::processPaddedFrameIfNeeded() {
  if (processedFrameCount_ > 0) {
    return;
  }

  const size_t available = pending_.size() - readOffset_;
  if (available == 0) {
    return;
  }

  std::vector<float> frame(static_cast<size_t>(fftSize_), 0.0F);
  const size_t toCopy = std::min(available, static_cast<size_t>(fftSize_));
  std::copy_n(pending_.data() + readOffset_, toCopy, frame.data());
  processFrame(frame.data());
}

void AudioVisualizationAccumulator::processFrame(const float *frame) {
  ensureWorkBuffers();

  const int64_t currentWindowIndex = frameWindowIndex_;
  frameWindowIndex_ += 1;

  const int64_t centerSample =
      currentWindowIndex * static_cast<int64_t>(hopSize_) +
      static_cast<int64_t>(fftSize_ / 2);

  double rmsSum = 0.0;
  for (int i = 0; i < fftSize_; ++i) {
    const float sample = frame[i];
    rmsSum += static_cast<double>(sample) * static_cast<double>(sample);
    fftRe_[static_cast<size_t>(i)] =
        static_cast<double>(sample) * static_cast<double>(window_[static_cast<size_t>(i)]);
    fftIm_[static_cast<size_t>(i)] = 0.0;
  }

  const double rms = std::sqrt(rmsSum / static_cast<double>(fftSize_));
  if (rms < static_cast<double>(silenceRms_)) {
    return;
  }

  fftRadix2(fftRe_, fftIm_);

  std::vector<float> barPowers(static_cast<size_t>(barCount_), 0.0F);

  for (int i = 0; i < barCount_; ++i) {
    const auto &range = barBins_[static_cast<size_t>(i)];
    const int k0 = std::max(1, range.start);
    const int k1 = std::min((fftSize_ / 2) - 1, range.end);
    if (k1 < k0) {
      continue;
    }

    double sum = 0.0;
    int bins = 0;
    for (int k = k0; k <= k1; ++k) {
      const double re = fftRe_[static_cast<size_t>(k)];
      const double im = fftIm_[static_cast<size_t>(k)];
      sum += re * re + im * im;
      ++bins;
    }

    if (bins <= 0) {
      continue;
    }

    const float power = static_cast<float>(sum / static_cast<double>(bins));
    barPowers[static_cast<size_t>(i)] = power;
    float &agg = aggregateLevels_[static_cast<size_t>(i)];
    if (aggregateMode_ == AudioVisualizationAggregateMode::MEAN) {
      agg += power;
    } else {
      agg = std::max(agg, power);
    }
  }

  if (timelineEnabled_) {
    if (timelineFrameCountHint_ > 0) {
      appendTimelineWindowFrame(centerSample, barPowers);
    } else {
      const int bucket = std::max(
          0,
          static_cast<int>(std::floor(
              (static_cast<double>(centerSample) * 1000.0 /
               static_cast<double>(std::max(1, sampleRate_))) /
              timelineFrameDurationMsHint_)));
      ensureTimelineBucket(static_cast<size_t>(bucket));
      float *dst = timelineBuckets_.data() + static_cast<size_t>(bucket * barCount_);
      for (int b = 0; b < barCount_; ++b) {
        dst[b] = std::max(dst[b], barPowers[static_cast<size_t>(b)]);
      }
    }
  }

  ++processedFrameCount_;
}

void AudioVisualizationAccumulator::ensureWorkBuffers() {
  if (fftRe_.size() == static_cast<size_t>(fftSize_)) {
    return;
  }
  fftRe_.assign(static_cast<size_t>(fftSize_), 0.0);
  fftIm_.assign(static_cast<size_t>(fftSize_), 0.0);
}

void AudioVisualizationAccumulator::ensureTimelineBucket(size_t bucketIndex) {
  const size_t required = (bucketIndex + 1) * static_cast<size_t>(barCount_);
  if (timelineBuckets_.size() >= required) {
    return;
  }
  timelineBuckets_.resize(required, 0.0F);
}

void AudioVisualizationAccumulator::appendTimelineWindowFrame(
    int64_t centerSample,
    const std::vector<float> &barPowers) {
  timelineWindowCenterSamples_.push_back(centerSample);
  timelineWindowBars_.push_back(barPowers);
}

int AudioVisualizationAccumulator::nextPowerOfTwo(int value) {
  if (value <= 1) {
    return 1;
  }
  int p = 1;
  while (p < value && p < (1 << 30)) {
    p <<= 1;
  }
  return p;
}

bool AudioVisualizationAccumulator::isPowerOfTwo(int value) {
  return value > 0 && (value & (value - 1)) == 0;
}

int AudioVisualizationAccumulator::hzToBin(double hz, int sampleRate, int fftSize) {
  if (sampleRate <= 0 || fftSize <= 0) {
    return 1;
  }
  const int maxBin = (fftSize / 2) - 1;
  const int bin = static_cast<int>(std::llround((hz * fftSize) / sampleRate));
  return clampInt(bin, 1, std::max(1, maxBin));
}

void AudioVisualizationAccumulator::fftRadix2(
    std::vector<double> &re,
    std::vector<double> &im) {
  const size_t n = re.size();
  if (n <= 1) {
    return;
  }

  size_t j = 0;
  for (size_t i = 1; i < n; ++i) {
    size_t bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;

    if (i < j) {
      std::swap(re[i], re[j]);
      std::swap(im[i], im[j]);
    }
  }

  for (size_t len = 2; len <= n; len <<= 1) {
    const double angle = -2.0 * kPi / static_cast<double>(len);
    const double wLenRe = std::cos(angle);
    const double wLenIm = std::sin(angle);

    for (size_t i = 0; i < n; i += len) {
      double wRe = 1.0;
      double wIm = 0.0;

      const size_t half = len >> 1;
      for (size_t k = 0; k < half; ++k) {
        const size_t u = i + k;
        const size_t v = u + half;

        const double tRe = re[v] * wRe - im[v] * wIm;
        const double tIm = re[v] * wIm + im[v] * wRe;

        re[v] = re[u] - tRe;
        im[v] = im[u] - tIm;
        re[u] += tRe;
        im[u] += tIm;

        const double nextWRe = wRe * wLenRe - wIm * wLenIm;
        const double nextWIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextWRe;
        wIm = nextWIm;
      }
    }
  }
}

float AudioVisualizationAccumulator::powerToUnit(float power) const {
  const double safePower = std::max<double>(power, 1.0e-18);
  const double db = 10.0 * std::log10(safePower);
  const double norm =
      (db - static_cast<double>(minDb_)) /
      static_cast<double>(std::max(1.0F, maxDb_ - minDb_));
  return clampFloat(static_cast<float>(norm), 0.0F, 1.0F);
}

AudioVisualizationProfile computeAudioVisualizationProfile(
    const float *samples,
    int sampleCount,
    const AudioVisualizationConfig &config) {
  AudioVisualizationAccumulator acc(config);
  acc.feed(samples, sampleCount);
  return acc.finish();
}

std::string storeVisualizationFramesForTransfer(std::vector<float> &&frames) {
  if (frames.empty()) {
    return "";
  }

  sweepVisualizationFrameTransfers();

  const uint64_t n = gVisualizationTransferCounter.fetch_add(1);
  const std::string transferId =
      std::string("viz_tx_") + std::to_string(nowMs()) + "_" +
      std::to_string(n);

  std::lock_guard<std::mutex> lock(gVisualizationTransferMutex);
  gVisualizationTransferStore.emplace(
      transferId,
      VisualizationTransferEntry{std::move(frames), nowMs()});
  return transferId;
}

bool takeVisualizationFramesTransfer(
    const std::string &transferId,
    std::vector<float> *outFrames) {
  if (!outFrames || transferId.empty()) {
    return false;
  }

  sweepVisualizationFrameTransfers();

  std::lock_guard<std::mutex> lock(gVisualizationTransferMutex);
  auto it = gVisualizationTransferStore.find(transferId);
  if (it == gVisualizationTransferStore.end()) {
    return false;
  }

  *outFrames = std::move(it->second.frames);
  gVisualizationTransferStore.erase(it);
  return true;
}

void sweepVisualizationFrameTransfers(int64_t maxAgeMs) {
  if (maxAgeMs <= 0) {
    return;
  }

  const int64_t threshold = nowMs() - maxAgeMs;
  std::lock_guard<std::mutex> lock(gVisualizationTransferMutex);
  for (auto it = gVisualizationTransferStore.begin();
       it != gVisualizationTransferStore.end();) {
    if (it->second.createdAtMs < threshold) {
      it = gVisualizationTransferStore.erase(it);
    } else {
      ++it;
    }
  }
}

}  // namespace sherpa
