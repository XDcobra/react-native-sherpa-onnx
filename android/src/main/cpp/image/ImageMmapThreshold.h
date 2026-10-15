#pragma once

#include <cstdint>

namespace sherpa_onnx {
namespace image {

enum class ImageRamClass {
  Low,
  Mid,
  High,
  VeryHigh,
};

enum class ImageThresholdPathType {
  FileOrigin,
  HeapOrigin,
};

enum class ImageThresholdPlatform {
  Android,
  Ios,
};

/**
 * Shared threshold policy for ImageBuffer mmap upgrades.
 * Android bases: file 6 MB, heap 10 MB.
 * iOS bases: file 8 MB, heap 12 MB.
 */
class ImageMmapThreshold {
 public:
  static ImageRamClass ClassifyRam(uint64_t totalRamBytes);

  static int64_t ThresholdBytes(ImageThresholdPlatform platform,
                                ImageRamClass ramClass,
                                ImageThresholdPathType pathType);

  static const char* RamClassName(ImageRamClass ramClass);
};

}  // namespace image
}  // namespace sherpa_onnx
