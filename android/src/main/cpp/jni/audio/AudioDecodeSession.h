#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>

namespace sherpa {

struct AudioDecodeConfig {
  int targetSampleRate = 0;  // 0 = keep source rate
  bool forceMono = true;
  int chunkSize = 8192;      // output frames per callback
  /** When false, avformat_open_input will not fall back to auto-probe after explicit demuxer failure. */
  bool allowDemuxerAutoProbe = true;
};

struct AudioDecodeResult {
  int64_t totalFramesDecoded = 0;
  int sourceSampleRate = 0;
  int sourceChannels = 0;
};

struct AudioFileProbeResult {
  int64_t durationMs = -1;  // -1 = unknown
  bool isExact = false;     // true when container/stream duration is reliable
};

/** Container + primary audio codec detected by FFmpeg (or WAV header). No PCM decode. */
struct AudioContainerProbeResult {
  std::string inputFormatName;  // iformat->name, e.g. "ogg", "mp3", "mov"
  std::string codecName;        // avcodec_get_name, e.g. "opus", "aac"
};

using DecodeChunkCallback =
    std::function<void(const float* samples, int frameCount)>;

using DecodeProgressCallback =
    std::function<void(int64_t framesDecoded, int64_t totalFramesEstimate, int percent)>;

/** Invoked once when source stream layout is known, before any onChunk/onProgress. */
using DecodeStreamInfoCallback =
    std::function<void(int sourceSampleRate, int sourceChannels)>;

/**
 * Decode an audio file to float32 PCM chunks.
 *
 * Blocks the calling thread until decode completes, errors, or is cancelled.
 * Chunks are delivered via onChunk callback.
 *
 * WAV fast path: PCM WAV (s16le/f32le mono) at matching target rate bypasses FFmpeg.
 * All other formats use FFmpeg demux → decode → SwrContext resample/downmix.
 *
 * Throws std::runtime_error with DECODE_* error code prefix on failure.
 */
AudioDecodeResult decodeFile(
    const char* pathOrFd,
    int inputFd,
    const AudioDecodeConfig& config,
    DecodeChunkCallback onChunk,
    DecodeProgressCallback onProgress,       // may be nullptr
    DecodeStreamInfoCallback onStreamInfo,   // may be nullptr
    std::atomic<bool>& cancelFlag
);

inline AudioDecodeResult decodeFile(
    const char* pathOrFd,
    const AudioDecodeConfig& config,
    DecodeChunkCallback onChunk,
    DecodeProgressCallback onProgress,
    DecodeStreamInfoCallback onStreamInfo,
    std::atomic<bool>& cancelFlag
) {
    return decodeFile(pathOrFd, -1, config, onChunk, onProgress, onStreamInfo, cancelFlag);
}

/**
 * Probe audio file duration from container metadata only (no decode).
 *
 * WAV: exact duration from fmt/data chunks. Other formats: FFmpeg demux when available.
 * Throws std::runtime_error with PROBE_* error code prefix on failure.
 */
AudioFileProbeResult probeFileDuration(const char* pathOrFd, int inputFd = -1);

inline AudioFileProbeResult probeFileDuration(const char* pathOrFd) {
  return probeFileDuration(pathOrFd, -1);
}

/**
 * Probe container format and primary audio codec (no PCM decode).
 * Uses FFmpeg auto-probe when needed so mislabeled extensions are detected.
 * Throws std::runtime_error with PROBE_* error code prefix on failure.
 */
AudioContainerProbeResult probeFileContainer(const char* pathOrFd, int inputFd = -1);

inline AudioContainerProbeResult probeFileContainer(const char* pathOrFd) {
  return probeFileContainer(pathOrFd, -1);
}

} // namespace sherpa
