#include "preview/PlaybackClock.h"

#include <algorithm>
#include <ctime>

#if defined(__APPLE__)
#include <mach/mach_time.h>
#endif

namespace sherpa_onnx {
namespace video {
namespace preview {

int64_t MonotonicClock::NowNs() const {
  if (nowNsOverride_ >= 0) {
    return nowNsOverride_;
  }
#if defined(__APPLE__)
  static mach_timebase_info_data_t tb;
  static bool init = false;
  if (!init) {
    mach_timebase_info(&tb);
    init = true;
  }
  return static_cast<int64_t>(mach_absolute_time() * tb.numer / tb.denom);
#else
  timespec ts{};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<int64_t>(ts.tv_sec) * 1000000000LL + ts.tv_nsec;
#endif
}

int64_t MonotonicClock::NowMediaUs() {
  if (rate_ <= 0) {
    return anchorMediaUs_;
  }
  const int64_t now = NowNs();
  const int64_t deltaUs = (now - anchorNs_) / 1000;
  return anchorMediaUs_ + static_cast<int64_t>(deltaUs * rate_);
}

void MonotonicClock::SetRate(double rate, int64_t atMediaUs) {
  anchorNs_ = NowNs();
  anchorMediaUs_ = atMediaUs;
  rate_ = rate;
}

void AudioClockEstimator::ResetSegment(int64_t ptsUs, int64_t writtenAtStart) {
  anchorPtsUs = ptsUs;
  anchorFrame = writtenAtStart;
  framesWritten = writtenAtStart;
  tsFrame = -1;
  haveTs = false;
  lastMediaUs = ptsUs;
}

void AudioClockEstimator::OnTimestamp(int64_t framePosition, int64_t nanoTime) {
  tsFrame = framePosition;
  tsNanoTime = nanoTime;
  haveTs = true;
}

void AudioClockEstimator::OnHead(int64_t playbackHeadFrames) {
  if (!haveTs) {
    tsFrame = playbackHeadFrames;
  }
}

int64_t AudioClockEstimator::Media(int64_t nowNs, int64_t* correctionUs) const {
  if (sampleRate <= 0 || rate <= 0) {
    return lastMediaUs;
  }
  int64_t frame = haveTs ? tsFrame : (tsFrame >= 0 ? tsFrame : anchorFrame);
  if (frame < anchorFrame) {
    frame = anchorFrame;
  }
  if (frame > framesWritten) {
    frame = framesWritten;
  }
  int64_t media = anchorPtsUs +
                  ((frame - anchorFrame) * 1000000LL) / sampleRate;
  if (haveTs && rate > 0) {
    media += (nowNs - tsNanoTime) / 1000;
  }
  if (correctionUs) {
    *correctionUs = media - lastMediaUs;
  }
  return media;
}

int64_t AudioClockEstimator::ApplyGuards(int64_t candidateUs, int64_t nowNs,
                                         bool* snapped) {
  (void)nowNs;
  if (snapped) *snapped = false;
  if (rate <= 0) {
    lastMediaUs = candidateUs;
    return lastMediaUs;
  }
  const int64_t maxWritten =
      anchorPtsUs +
      ((framesWritten - anchorFrame) * 1000000LL) / std::max(sampleRate, 1);
  if (candidateUs > maxWritten) {
    candidateUs = maxWritten;
  }
  if (candidateUs < lastMediaUs) {
    candidateUs = lastMediaUs;
  }
  const int64_t err = candidateUs - lastMediaUs;
  if (err > 80000) {
    lastMediaUs = candidateUs;
    if (snapped) *snapped = true;
    return lastMediaUs;
  }
  const int64_t slew = std::min<int64_t>(err, 5000);
  lastMediaUs += slew;
  return lastMediaUs;
}

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
