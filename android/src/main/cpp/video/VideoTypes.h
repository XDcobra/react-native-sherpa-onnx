#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace video {

inline constexpr int kAlignBytes = 64;

inline int AlignUp(int value, int align = kAlignBytes) {
  if (value <= 0 || align <= 1) {
    return value;
  }
  return (value + align - 1) & ~(align - 1);
}

inline const char* kErrInvalidArgument = "VIDEO_INVALID_ARGUMENT";
inline const char* kErrBufferNotFound = "VIDEO_BUFFER_NOT_FOUND";
inline const char* kErrKindMismatch = "VIDEO_BUFFER_KIND_MISMATCH";
inline const char* kErrInvalidState = "VIDEO_BUFFER_INVALID_STATE";
inline const char* kErrFfmpegDisabled = "VIDEO_FFMPEG_DISABLED";
inline const char* kErrContainerUnsupported = "VIDEO_CONTAINER_UNSUPPORTED";
inline const char* kErrNoVideoTrack = "VIDEO_NO_VIDEO_TRACK";
inline const char* kErrCodecUnsupported = "VIDEO_CODEC_UNSUPPORTED";
inline const char* kErrDecoderUnavailable = "VIDEO_DECODER_UNAVAILABLE";
inline const char* kErrDecodeFailed = "VIDEO_DECODE_FAILED";
inline const char* kErrFrameOutOfRange = "VIDEO_FRAME_OUT_OF_RANGE";
inline const char* kErrFrameEvicted = "VIDEO_FRAME_EVICTED";
inline const char* kErrMemoryBudget = "VIDEO_MEMORY_BUDGET_EXCEEDED";
inline const char* kErrSpoolIo = "VIDEO_SPOOL_IO";
inline const char* kErrCancelled = "VIDEO_CANCELLED";
inline const char* kErrFileCorrupt = "VIDEO_FILE_CORRUPT";

struct Status {
  bool ok = true;
  std::string errorCode;
  std::string errorMessage;

  static Status Ok() { return {}; }
  static Status Fail(const char* code, std::string message) {
    Status s;
    s.ok = false;
    s.errorCode = code ? code : kErrInvalidArgument;
    s.errorMessage = std::move(message);
    return s;
  }
};

template <typename T>
struct Result {
  Status status;
  T value{};
  bool ok() const { return status.ok; }
};

enum class VideoCodec { H264, Hevc };

enum class ColorMatrix { Bt601, Bt709, Bt2020 };

enum class ColorRange { Limited, Full };

enum class VideoPixelFormat { Nv12, Gray8, Rgb24 };

enum class SeekMode { Keyframe, Accurate, ClosestKeyframe };

enum class SamplingMode { All, Fps, StrideUs, Keyframes, Uniform, Times };

enum class LagPolicy { DropToLatestKeyframe, Error, Block };

enum class MemoryPressureLevel { Moderate, Critical };

enum class VideoKind { Offline, Live };

enum class VideoBufferState { Immutable, Recording, Finished };

enum class VideoStorageKind { Container, Ring, Spool };

enum class IndexState { Complete, Building };

enum class VideoRamClass { Low, Mid, High, VeryHigh };

struct VideoTransform {
  int rotationDegrees = 0;  // 0, 90, 180, 270 (clockwise display)
  bool mirrorHorizontal = false;
};

struct Rational {
  int num = 0;
  int den = 1;
};

struct VideoTrackInfo {
  VideoCodec codec = VideoCodec::H264;
  int codedWidth = 0;
  int codedHeight = 0;
  int displayWidth = 0;
  int displayHeight = 0;
  VideoTransform transform;
  ColorMatrix matrix = ColorMatrix::Bt601;
  ColorRange range = ColorRange::Limited;
  Rational nominalFps;
  bool variableFrameRate = false;
  std::vector<uint8_t> codecConfig;
};

enum SampleFlags : uint32_t {
  kSampleKey = 1u << 0,
  kSampleNonRef = 1u << 1,
  kSampleDiscontinuity = 1u << 2,
};

struct SampleEntry {
  int64_t ptsUs = 0;
  int64_t dtsUs = 0;
  int64_t fileOffset = -1;
  uint32_t size = 0;
  uint32_t flags = 0;
};

struct EncodedPacket {
  int64_t ptsUs = 0;
  int64_t dtsUs = 0;
  uint32_t flags = 0;
  std::vector<uint8_t> payload;
};

struct PlaneView {
  const uint8_t* data = nullptr;
  int stride = 0;
};

struct Nv12View {
  PlaneView y;
  PlaneView uv;
  int width = 0;
  int height = 0;
};

struct MutablePlane {
  uint8_t* data = nullptr;
  int stride = 0;
};

struct MutableNv12 {
  MutablePlane y;
  MutablePlane uv;
  int width = 0;
  int height = 0;
};

struct PackedPlane {
  uint8_t* data = nullptr;
  int stride = 0;
  int width = 0;
  int height = 0;
};

struct VideoFrameView {
  const uint8_t* plane[3] = {nullptr, nullptr, nullptr};
  int stride[3] = {0, 0, 0};
  int width = 0;
  int height = 0;
  VideoPixelFormat format = VideoPixelFormat::Nv12;
  int64_t ptsUs = 0;
  int64_t frameIndex = -1;
};

struct FrameRequest {
  int64_t ptsUs = 0;
  SeekMode mode = SeekMode::Accurate;
  VideoPixelFormat format = VideoPixelFormat::Nv12;
  int maxSide = 0;
  bool applyTransform = true;
  bool packed = false;
};

struct IterateRequest {
  int64_t startUs = 0;
  int64_t endUs = -1;
  SamplingMode sampling = SamplingMode::All;
  double fps = 0;
  int64_t strideUs = 0;
  int uniformCount = 0;
  std::vector<int64_t> timesUs;
  VideoPixelFormat format = VideoPixelFormat::Nv12;
  int maxSide = 0;
  bool applyTransform = true;
  bool packed = false;
  LagPolicy lagPolicy = LagPolicy::DropToLatestKeyframe;
};

/** Round maxSide up to the analysis-size ladder (320/640/960/1280/full). */
inline int AnalysisSizeBucket(int maxSide) {
  if (maxSide <= 0) {
    return 0;
  }
  static constexpr int kBuckets[] = {320, 640, 960, 1280};
  for (int b : kBuckets) {
    if (maxSide <= b) {
      return b;
    }
  }
  return 0;
}

struct TimeRange {
  int64_t startUs = 0;
  int64_t endUs = 0;
};

struct VideoBufferInfo {
  std::string bufferId;
  VideoKind kind = VideoKind::Offline;
  VideoBufferState state = VideoBufferState::Immutable;
  VideoStorageKind storageKind = VideoStorageKind::Container;
  VideoTrackInfo track;
  int64_t frameCount = 0;
  bool frameCountExact = true;
  IndexState indexState = IndexState::Complete;
  TimeRange seekableRange;
  TimeRange ringRange;
  TimeRange spoolRange;
  int64_t liveEdgeUs = -1;
  int64_t totalFramesWritten = 0;
  int64_t ringEvictedFrames = 0;
  bool hasActiveSpool = false;
};

inline const char* VideoCodecName(VideoCodec c) {
  return c == VideoCodec::Hevc ? "hevc" : "h264";
}

inline ColorMatrix InferColorMatrix(int height, ColorMatrix specified,
                                    bool specifiedSet) {
  if (specifiedSet) {
    return specified;
  }
  return height >= 720 ? ColorMatrix::Bt709 : ColorMatrix::Bt601;
}

}  // namespace video
}  // namespace sherpa_onnx
