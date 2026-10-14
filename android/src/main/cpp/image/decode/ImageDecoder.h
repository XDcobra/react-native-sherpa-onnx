#pragma once

#include "../ImageTypes.h"

#include <cstdint>
#include <string>

namespace sherpa_onnx {
namespace image {

/**
 * Portable decode: JPEG/PNG/BMP/GIF via stb_image, WebP via libwebp,
 * EXIF orientation for JPEG, then optional maxSide downscale.
 * HEIC is not handled here (platform bridge → AdoptRgbFrame).
 */
class ImageDecoder {
 public:
  static DecodeResult DecodeFile(const std::string& path,
                                 const DecodeOptions& opts = {});

  static DecodeResult DecodeBytes(const uint8_t* data, size_t size,
                                  const DecodeOptions& opts = {});

  /** Sniff magic bytes (does not allocate). */
  static DecodeFormat DetectFormat(const uint8_t* data, size_t size);

  /**
   * Apply EXIF orientation 1..8 in-place on an RGB8 buffer.
   * Returns the orientation that was applied (1 if none/invalid).
   */
  static int ApplyExifOrientation(RgbFrame& frame, int orientation);

  /** Downscale so max(width,height) <= maxSide. No-op if maxSide <= 0. */
  static float ApplyMaxSide(RgbFrame& frame, int maxSide);
};

}  // namespace image
}  // namespace sherpa_onnx
