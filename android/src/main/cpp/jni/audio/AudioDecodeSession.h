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
};

struct AudioDecodeResult {
  int64_t totalFramesDecoded = 0;
  int sourceSampleRate = 0;
  int sourceChannels = 0;
};

using DecodeChunkCallback =
    std::function<void(const float* samples, int frameCount)>;

using DecodeProgressCallback =
    std::function<void(int64_t framesDecoded, int64_t totalFramesEstimate, int percent)>;

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
    const AudioDecodeConfig& config,
    DecodeChunkCallback onChunk,
    DecodeProgressCallback onProgress,   // may be nullptr
    std::atomic<bool>& cancelFlag
);

} // namespace sherpa
