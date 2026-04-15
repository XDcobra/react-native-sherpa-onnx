#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace sherpa {

struct AudioEncodeConfig {
  const char* outputPath;        // Output file path
  const char* formatHint;        // "wav", "mp3", "flac", "aac", "m4a", "opus", "webm", "mkv", "ogg"
  int inputSampleRate;           // Source PCM sample rate
  int inputChannelCount;         // Source PCM channel count (typically 1)
  int outputSampleRateHz;        // 0 = format-dependent default
  int bitrate;                   // kbps for lossy codecs, 0 = codec default or quality-derived
  int quality;                   // 0=default, 1=low, 2=medium, 3=high
};

using EncodeProgressCallback =
    std::function<void(int64_t framesEncoded, int64_t totalFramesEstimate, int percent)>;

/**
 * Streaming audio encoder backed by FFmpeg (with WAV fast-path).
 *
 * Usage:
 *   auto session = AudioEncodeSession::create(config, totalFramesEstimate, onProgress, cancelFlag, errorOut);
 *   session->feedChunk(samples, frameCount);  // repeat
 *   session->finish();  // flush + close
 *
 * Thread safety: create/feedChunk/finish must be called from same thread.
 * Cancel flag can be set from any thread.
 */
class AudioEncodeSession {
public:
  static std::unique_ptr<AudioEncodeSession> create(
      const AudioEncodeConfig& config,
      int64_t totalFramesEstimate,
      EncodeProgressCallback onProgress,
      std::atomic<bool>& cancelFlag,
      std::string& errorOut
  );

  ~AudioEncodeSession();

  std::string feedChunk(const float* samples, int frameCount);
  std::string finish();

  int64_t framesEncoded() const;

private:
  AudioEncodeSession();
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace sherpa
