#pragma once

#include "ImageTypes.h"

#include <cstdint>
#include <string>

namespace sherpa_onnx {
namespace image {

enum class ExportFormat {
  Jpeg,
  Png,
  Webp,
};

struct ExportOptions {
  ExportFormat format = ExportFormat::Jpeg;
  /** JPEG/WebP quality 1..100 (clamped). Ignored for PNG. */
  int quality = 85;
  /** Display/export downsample; <= 0 keeps full frame size. */
  int maxSide = 0;
};

struct ExportResult {
  bool ok = false;
  std::string errorCode;
  std::string errorMessage;
};

/** Parse "jpeg"|"jpg"|"png"|"webp" (case-insensitive). Returns false if unknown. */
bool ParseExportFormat(const std::string& name, ExportFormat* out);

/**
 * Copy one frame from the registry (optional maxSide) into [out].
 * Always clones into [out] (needed when maxSide > 0 mutates).
 * Returns false if buffer/frame missing.
 */
bool CopyFrameRgb(const std::string& bufferId, int frameIndex, int maxSide,
                  RgbFrame& out);

/**
 * Resolve frame RGB for read-only consumers.
 * - maxSide <= 0: [outPtr]/outW]/outH] point at registry memory (no heap clone).
 * - maxSide > 0: clones + downscales into [scratch]; [outPtr] points at scratch.rgb.
 * Returns false if buffer/frame missing.
 */
bool ResolveFrameRgb(const std::string& bufferId, int frameIndex, int maxSide,
                     RgbFrame& scratch, const uint8_t** outPtr, int* outW,
                     int* outH);

/**
 * Encode packed RGB8 (row-major, stride = width*3) to [outPath].
 * JPEG/PNG stream chunks to the file; WebP allocates then writes once.
 */
ExportResult EncodeRgbBytesToFile(const uint8_t* rgb, int width, int height,
                                  const std::string& outPath,
                                  const ExportOptions& opts);

/**
 * Encode a registry frame to [outPath] (absolute filesystem path).
 * When maxSide <= 0, encodes from GetFrameRgbPtr without an RGB heap clone.
 */
ExportResult ExportFrameToFile(const std::string& bufferId, int frameIndex,
                               const std::string& outPath,
                               const ExportOptions& opts);

/** Encode an in-memory RGB frame to [outPath]. */
ExportResult EncodeRgbFrameToFile(const RgbFrame& frame,
                                  const std::string& outPath,
                                  const ExportOptions& opts);

/** Pack RGB8 → ARGB8888 (native endian, alpha 0xFF). dest length >= w*h. */
void FillArgb8888FromRgb(const uint8_t* rgb, int width, int height,
                         uint32_t* destArgb);

}  // namespace image
}  // namespace sherpa_onnx
