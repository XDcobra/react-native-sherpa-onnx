#include "ImageMmapThreshold.h"

#include <algorithm>
#include <cmath>

namespace sherpa_onnx {
namespace image {

namespace {

constexpr int64_t kMb = 1024LL * 1024LL;
constexpr int64_t kMinThresholdBytes = 4LL * kMb;
constexpr int64_t kMaxThresholdBytes = 32LL * kMb;

constexpr uint64_t kLowRamMaxBytes = 3ULL * 1024ULL * 1024ULL * 1024ULL;
constexpr uint64_t kMidRamMaxBytes = 6ULL * 1024ULL * 1024ULL * 1024ULL;
constexpr uint64_t kHighRamMaxBytes = 12ULL * 1024ULL * 1024ULL * 1024ULL;

constexpr double kAndroidFileOriginBaseMb = 6.0;
constexpr double kAndroidHeapOriginBaseMb = 10.0;
constexpr double kIosFileOriginBaseMb = 8.0;
constexpr double kIosHeapOriginBaseMb = 12.0;

constexpr double kMultiplierLow = 0.75;
constexpr double kMultiplierMid = 1.0;
constexpr double kMultiplierHigh = 1.5;
constexpr double kMultiplierVeryHigh = 2.0;

double MultiplierFor(ImageRamClass ramClass) {
  switch (ramClass) {
    case ImageRamClass::Low:
      return kMultiplierLow;
    case ImageRamClass::Mid:
      return kMultiplierMid;
    case ImageRamClass::High:
      return kMultiplierHigh;
    case ImageRamClass::VeryHigh:
      return kMultiplierVeryHigh;
  }
  return kMultiplierMid;
}

int64_t ClampThreshold(int64_t bytes) {
  return std::max(kMinThresholdBytes, std::min(kMaxThresholdBytes, bytes));
}

}  // namespace

ImageRamClass ImageMmapThreshold::ClassifyRam(uint64_t totalRamBytes) {
  if (totalRamBytes <= kLowRamMaxBytes) return ImageRamClass::Low;
  if (totalRamBytes <= kMidRamMaxBytes) return ImageRamClass::Mid;
  if (totalRamBytes <= kHighRamMaxBytes) return ImageRamClass::High;
  return ImageRamClass::VeryHigh;
}

int64_t ImageMmapThreshold::ThresholdBytes(ImageThresholdPlatform platform,
                                           ImageRamClass ramClass,
                                           ImageThresholdPathType pathType) {
  const double multiplier = MultiplierFor(ramClass);
  double baseMb = 0.0;
  if (platform == ImageThresholdPlatform::Android) {
    baseMb = (pathType == ImageThresholdPathType::FileOrigin)
                 ? kAndroidFileOriginBaseMb
                 : kAndroidHeapOriginBaseMb;
  } else {
    baseMb = (pathType == ImageThresholdPathType::FileOrigin)
                 ? kIosFileOriginBaseMb
                 : kIosHeapOriginBaseMb;
  }
  const auto raw =
      static_cast<int64_t>(std::llround(baseMb * multiplier * static_cast<double>(kMb)));
  return ClampThreshold(raw);
}

const char* ImageMmapThreshold::RamClassName(ImageRamClass ramClass) {
  switch (ramClass) {
    case ImageRamClass::Low:
      return "LOW";
    case ImageRamClass::Mid:
      return "MID";
    case ImageRamClass::High:
      return "HIGH";
    case ImageRamClass::VeryHigh:
      return "VERY_HIGH";
  }
  return "MID";
}

}  // namespace image
}  // namespace sherpa_onnx
