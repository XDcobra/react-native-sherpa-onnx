#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace image {

/** Packed RGB8 frame (row-major, 3 bytes/pixel, no padding). */
struct RgbFrame {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> rgb;
  /** 1-based PDF page number; 0 = unset (file/base64 creates). */
  int pageNumber = 0;
  /** Raster DPI used when producing this frame; 0 = unset. */
  int dpi = 0;
  /** 0-based document section; -1 = unset. */
  int sectionIndex = -1;
  /** EPUB path / archive member. */
  std::string href;
  /** Optional VideoBuffer origin (VideoImageBridge). */
  std::string sourceVideoBufferId;
  int64_t sourcePtsUs = -1;
  int64_t sourceFrameIndex = -1;

  size_t byteSize() const {
    return static_cast<size_t>(width) * static_cast<size_t>(height) * 3u;
  }

  bool valid() const {
    return width > 0 && height > 0 && rgb.size() == byteSize();
  }
};

enum class ImageStorageKind {
  Ram,
  Mmap,
};

inline const char* StorageKindName(ImageStorageKind kind) {
  return kind == ImageStorageKind::Mmap ? "mmap" : "ram";
}

/** Buffer kind: offline (`img_off_`) vs live (`img_live_`). */
enum class ImageBufferKind {
  Offline,
  Live,
};

inline const char* BufferKindName(ImageBufferKind kind) {
  return kind == ImageBufferKind::Live ? "liveImageBuffer" : "offlineImageBuffer";
}

/** Buffer lifecycle state exposed to JS. */
enum class ImageBufferState {
  Immutable,
  Lazy,
  Recording,
  Finished,
};

inline const char* BufferStateName(ImageBufferState state) {
  switch (state) {
    case ImageBufferState::Lazy:
      return "lazy";
    case ImageBufferState::Recording:
      return "recording";
    case ImageBufferState::Finished:
      return "finished";
    default:
      return "immutable";
  }
}

enum class ImageRetention {
  Session,
  None,
};

/** Decode options. maxSide <= 0 means no downscale. Default 4096. */
struct DecodeOptions {
  int maxSide = 4096;
  /** Lazy file create only. 0 = default 8, clamped 1..32. Ignored by ImageDecoder. */
  int hotFrames = 0;
  /** Empty = cascade default. "hardware" | "software" | "preferHardware". */
  std::string decodePolicy;
};

struct LiveImageOptions {
  int ringFrames = 16;
  ImageRetention retention = ImageRetention::Session;
  DecodeOptions decode;
};

struct CompressedImageFrame {
  int64_t index = 0;
  std::vector<uint8_t> bytes;
};

struct ImageFrameInfo {
  int index = 0;
  int width = 0;
  int height = 0;
  int64_t byteSize = 0;
  ImageStorageKind storageKind = ImageStorageKind::Ram;
  /** 1-based PDF page number; 0 = unset. */
  int pageNumber = 0;
  /** Raster DPI; 0 = unset. */
  int dpi = 0;
  /** 0-based document section; -1 = unset. */
  int sectionIndex = -1;
  std::string href;
  std::string sourceVideoBufferId;
  int64_t sourcePtsUs = -1;
  int64_t sourceFrameIndex = -1;
  std::string decoderProvider;
  std::string decoderTier;
  std::string decoderOrigin;
};

struct ImageBufferInfo {
  std::string bufferId;
  ImageBufferKind kind = ImageBufferKind::Offline;
  int frameCount = 0;
  int64_t totalBytes = 0;
  ImageStorageKind storageKind = ImageStorageKind::Ram;
  ImageBufferState state = ImageBufferState::Immutable;
  int64_t totalFramesWritten = 0;
  int64_t ringEvictedFrames = 0;
  bool hasActiveSpool = false;
};

enum class DecodeFormat {
  Unknown,
  Jpeg,
  Png,
  Bmp,
  Gif,
  Webp,
  Heic,  // platform path only; C++ decoder rejects
};

inline const char* DecodeFormatName(DecodeFormat f) {
  switch (f) {
    case DecodeFormat::Jpeg: return "jpeg";
    case DecodeFormat::Png: return "png";
    case DecodeFormat::Bmp: return "bmp";
    case DecodeFormat::Gif: return "gif";
    case DecodeFormat::Webp: return "webp";
    case DecodeFormat::Heic: return "heic";
    default: return "unknown";
  }
}

struct DecodeResult {
  bool ok = false;
  std::string errorCode;     // e.g. ERR_IMAGE_DECODE_FAILED
  std::string errorMessage;
  DecodeFormat format = DecodeFormat::Unknown;
  int orientationApplied = 1;  // EXIF 1..8; 1 = identity
  float scaleApplied = 1.f;
  RgbFrame frame;
  std::string codecProvider;
  std::string codecTier;
  std::string codecOrigin;
};

}  // namespace image
}  // namespace sherpa_onnx
