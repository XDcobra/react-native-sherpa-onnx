/**
 * AudioDecodeSession — shared C++ decode primitive for both Android and iOS.
 *
 * Decodes any audio file to float32 mono PCM chunks using FFmpeg.
 * Includes a WAV fast path that bypasses FFmpeg for simple PCM WAV files.
 *
 * Used by:
 * - decodeFileToOfflineBuffer (offline buffer creation)
 * - startFileIngestToLiveBuffer (live buffer file ingest)
 * - audio_convert_file (conversion pipeline, future)
 */

#include "AudioDecodeSession.h"
#include "FfmpegFormatGuard.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

#ifdef __ANDROID__
#include <android/log.h>
#define LOG_TAG "AudioDecodeSession"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#elif defined(__APPLE__)
#include <os/log.h>
#define LOGI(fmt, ...) os_log_info(OS_LOG_DEFAULT, fmt, ##__VA_ARGS__)
#define LOGW(fmt, ...) os_log(OS_LOG_DEFAULT, fmt, ##__VA_ARGS__)
#define LOGE(fmt, ...) os_log_error(OS_LOG_DEFAULT, fmt, ##__VA_ARGS__)
#else
#define LOGI(...) ((void)0)
#define LOGW(...) ((void)0)
#define LOGE(...) ((void)0)
#endif

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libavutil/error.h>
#include <libswresample/swresample.h>
}
#endif

namespace sherpa {

// ==================== WAV Fast Path ====================

namespace {

#pragma pack(push, 1)
struct WavHeader {
  char riff[4];         // "RIFF"
  uint32_t fileSize;
  char wave[4];         // "WAVE"
};

struct WavFmtChunk {
  char id[4];           // "fmt "
  uint32_t size;
  uint16_t audioFormat; // 1 = PCM integer, 3 = IEEE float
  uint16_t numChannels;
  uint32_t sampleRate;
  uint32_t byteRate;
  uint16_t blockAlign;
  uint16_t bitsPerSample;
};
#pragma pack(pop)

struct WavInfo {
  int sampleRate;
  int channels;
  int bitsPerSample;
  uint16_t audioFormat;
  long dataOffset;
  long dataSize;
  bool valid;
};

WavInfo parseWavHeaderForFastPath(FILE* f) {
  WavInfo info = {};
  info.valid = false;

  WavHeader header;
  if (fread(&header, sizeof(header), 1, f) != 1) return info;
  if (memcmp(header.riff, "RIFF", 4) != 0 || memcmp(header.wave, "WAVE", 4) != 0) return info;

  // Find fmt and data chunks
  bool foundFmt = false;
  while (true) {
    char chunkId[4];
    uint32_t chunkSize;
    if (fread(chunkId, 4, 1, f) != 1) return info;
    if (fread(&chunkSize, 4, 1, f) != 1) return info;

    if (memcmp(chunkId, "fmt ", 4) == 0) {
      if (chunkSize < 16) return info;
      WavFmtChunk fmt;
      memcpy(fmt.id, chunkId, 4);
      fmt.size = chunkSize;
      if (fread(&fmt.audioFormat, sizeof(uint16_t), 1, f) != 1) return info;
      if (fread(&fmt.numChannels, sizeof(uint16_t), 1, f) != 1) return info;
      if (fread(&fmt.sampleRate, sizeof(uint32_t), 1, f) != 1) return info;
      if (fread(&fmt.byteRate, sizeof(uint32_t), 1, f) != 1) return info;
      if (fread(&fmt.blockAlign, sizeof(uint16_t), 1, f) != 1) return info;
      if (fread(&fmt.bitsPerSample, sizeof(uint16_t), 1, f) != 1) return info;

      info.audioFormat = fmt.audioFormat;
      info.sampleRate = (int)fmt.sampleRate;
      info.channels = (int)fmt.numChannels;
      info.bitsPerSample = (int)fmt.bitsPerSample;
      foundFmt = true;

      // Skip remaining fmt chunk bytes
      long remaining = (long)chunkSize - 16;
      if (remaining > 0) fseek(f, remaining, SEEK_CUR);
    } else if (memcmp(chunkId, "data", 4) == 0) {
      if (!foundFmt) return info;
      info.dataOffset = ftell(f);
      info.dataSize = (long)chunkSize;
      info.valid = true;
      return info;
    } else {
      // Skip unknown chunk
      if (chunkSize > 0) {
        // Align to 2-byte boundary
        uint32_t skip = chunkSize + (chunkSize & 1);
        fseek(f, (long)skip, SEEK_CUR);
      }
    }
  }
}

/**
 * Check if file qualifies for the WAV fast path:
 * - Valid RIFF/WAVE
 * - PCM 16-bit (format code 1) or IEEE float 32-bit (format code 3)
 * - Mono (1 channel)
 * - targetSampleRate == 0 or targetSampleRate == sourceRate
 */
bool canUseWavFastPath(const WavInfo& wav, const AudioDecodeConfig& config) {
  if (!wav.valid) return false;
  if (wav.channels != 1) return false;
  if (config.targetSampleRate != 0 && config.targetSampleRate != wav.sampleRate) return false;
  if (wav.audioFormat == 1 && wav.bitsPerSample == 16) return true;   // PCM S16LE
  if (wav.audioFormat == 3 && wav.bitsPerSample == 32) return true;   // IEEE Float32
  return false;
}

AudioFileProbeResult durationFromWavInfo(const WavInfo& wav) {
  AudioFileProbeResult result;
  if (!wav.valid || wav.sampleRate <= 0 || wav.channels <= 0 || wav.bitsPerSample <= 0) {
    return result;
  }
  const int bytesPerSample = wav.bitsPerSample / 8;
  if (bytesPerSample <= 0) {
    return result;
  }
  const int64_t bytesPerFrame = static_cast<int64_t>(wav.channels) * bytesPerSample;
  if (bytesPerFrame <= 0 || wav.dataSize <= 0) {
    return result;
  }
  const int64_t totalFrames = wav.dataSize / bytesPerFrame;
  result.durationMs = (totalFrames * 1000) / wav.sampleRate;
  result.isExact = result.durationMs >= 0;
  return result;
}

AudioFileProbeResult probeWavDuration(const char* pathOrFd, int inputFd) {
  FILE* f = nullptr;
  if (inputFd >= 0) {
    int probeFd = dup(inputFd);
    if (probeFd < 0) {
      throw std::runtime_error("PROBE_NOT_FOUND: Cannot duplicate input fd");
    }
    f = fdopen(probeFd, "rb");
    if (!f) {
      close(probeFd);
      throw std::runtime_error("PROBE_NOT_FOUND: Cannot open input fd");
    }
  } else {
    f = fopen(pathOrFd, "rb");
    if (!f) {
      throw std::runtime_error(std::string("PROBE_NOT_FOUND: Cannot open file: ") + pathOrFd);
    }
  }

  WavInfo wavInfo = parseWavHeaderForFastPath(f);
  fclose(f);

  if (wavInfo.valid) {
    return durationFromWavInfo(wavInfo);
  }
  return {};
}

AudioContainerProbeResult probeWavContainer(const char* pathOrFd, int inputFd) {
  FILE* f = nullptr;
  if (inputFd >= 0) {
    int probeFd = dup(inputFd);
    if (probeFd < 0) {
      throw std::runtime_error("PROBE_NOT_FOUND: Cannot duplicate input fd");
    }
    f = fdopen(probeFd, "rb");
    if (!f) {
      close(probeFd);
      throw std::runtime_error("PROBE_NOT_FOUND: Cannot open input fd");
    }
  } else {
    f = fopen(pathOrFd, "rb");
    if (!f) {
      throw std::runtime_error(std::string("PROBE_NOT_FOUND: Cannot open file: ") + pathOrFd);
    }
  }

  WavInfo wavInfo = parseWavHeaderForFastPath(f);
  fclose(f);

  AudioContainerProbeResult result;
  if (!wavInfo.valid) {
    return result;
  }

  result.inputFormatName = "wav";
  if (wavInfo.audioFormat == 3) {
    result.codecName = "pcm_f32le";
  } else if (wavInfo.audioFormat == 1) {
    result.codecName = "pcm_s16le";
  } else {
    result.codecName = "pcm";
  }
  return result;
}

AudioDecodeResult decodeWavFastPath(
    FILE* f,
    const WavInfo& wav,
    const AudioDecodeConfig& config,
    DecodeChunkCallback onChunk,
    DecodeProgressCallback onProgress,
    DecodeStreamInfoCallback onStreamInfo,
    std::atomic<bool>& cancelFlag
) {
  fseek(f, wav.dataOffset, SEEK_SET);

  if (onStreamInfo) {
    onStreamInfo(wav.sampleRate, wav.channels);
  }

  int bytesPerSample = wav.bitsPerSample / 8;
  int64_t totalSamples = wav.dataSize / bytesPerSample;
  int chunkSize = config.chunkSize > 0 ? config.chunkSize : 8192;

  std::vector<float> chunkBuf(chunkSize);
  int64_t framesDecoded = 0;

  if (wav.audioFormat == 3 && wav.bitsPerSample == 32) {
    // Float32 — direct read
    while (framesDecoded < totalSamples) {
      if (cancelFlag.load(std::memory_order_relaxed)) {
        throw std::runtime_error("DECODE_CANCELLED: Operation cancelled");
      }
      int toRead = (int)std::min((int64_t)chunkSize, totalSamples - framesDecoded);
      size_t read = fread(chunkBuf.data(), sizeof(float), toRead, f);
      if ((int)read <= 0) break;
      onChunk(chunkBuf.data(), (int)read);
      framesDecoded += (int)read;

      if (onProgress) {
        int pct = totalSamples > 0 ? (int)std::min<int64_t>(100, (framesDecoded * 100) / totalSamples) : 0;
        onProgress(framesDecoded, totalSamples, pct);
      }
    }
  } else {
    // S16LE — convert to float
    std::vector<int16_t> s16Buf(chunkSize);
    while (framesDecoded < totalSamples) {
      if (cancelFlag.load(std::memory_order_relaxed)) {
        throw std::runtime_error("DECODE_CANCELLED: Operation cancelled");
      }
      int toRead = (int)std::min((int64_t)chunkSize, totalSamples - framesDecoded);
      size_t read = fread(s16Buf.data(), sizeof(int16_t), toRead, f);
      if ((int)read <= 0) break;
      for (int i = 0; i < (int)read; ++i) {
        chunkBuf[i] = s16Buf[i] / 32768.0f;
      }
      onChunk(chunkBuf.data(), (int)read);
      framesDecoded += (int)read;

      if (onProgress) {
        int pct = totalSamples > 0 ? (int)std::min<int64_t>(100, (framesDecoded * 100) / totalSamples) : 0;
        onProgress(framesDecoded, totalSamples, pct);
      }
    }
  }

  AudioDecodeResult result;
  result.totalFramesDecoded = framesDecoded;
  result.sourceSampleRate = wav.sampleRate;
  result.sourceChannels = wav.channels;
  return result;
}

} // anonymous namespace

// ==================== FFmpeg Decode Path ====================

#ifdef HAVE_FFMPEG

namespace {

struct FdAvioContext {
  int fd = -1;
};

int avioReadFromFd(void* opaque, uint8_t* buf, int bufSize) {
  auto* ctx = reinterpret_cast<FdAvioContext*>(opaque);
  if (!ctx || ctx->fd < 0) {
    return AVERROR(EINVAL);
  }

  ssize_t n = read(ctx->fd, buf, static_cast<size_t>(bufSize));
  if (n == 0) {
    return AVERROR_EOF;
  }
  if (n < 0) {
    return AVERROR(errno);
  }

  return static_cast<int>(n);
}

int64_t avioSeekFd(void* opaque, int64_t offset, int whence) {
  auto* ctx = reinterpret_cast<FdAvioContext*>(opaque);
  if (!ctx || ctx->fd < 0) {
    return AVERROR(EINVAL);
  }

  if (whence == AVSEEK_SIZE) {
    struct stat st;
    if (fstat(ctx->fd, &st) != 0) {
      return AVERROR(errno);
    }
    return static_cast<int64_t>(st.st_size);
  }

  const int origin = whence & ~AVSEEK_FORCE;
  if (origin != SEEK_SET && origin != SEEK_CUR && origin != SEEK_END) {
    return AVERROR(EINVAL);
  }

  off_t result = lseek(ctx->fd, static_cast<off_t>(offset), origin);
  if (result < 0) {
    return AVERROR(errno);
  }
  return static_cast<int64_t>(result);
}

AudioDecodeResult decodeFileFFmpeg(
    const char* path,
    int inputFd,
    const AudioDecodeConfig& config,
    DecodeChunkCallback onChunk,
    DecodeProgressCallback onProgress,
    DecodeStreamInfoCallback onStreamInfo,
    std::atomic<bool>& cancelFlag
) {
  AVFormatContext* fmtCtx = nullptr;
  AVIOContext* avioCtx = nullptr;
  int ownedFd = -1;
  FdAvioContext fdAvioContext{};

  // RAII cleanup
  struct Cleanup {
    AVFormatContext** fmtCtx;
    AVCodecContext** decCtx;
    SwrContext** swr;
    AVFrame** frame;
    AVPacket** pkt;
    AVIOContext** avioCtx;
    int* ownedFd;
    ~Cleanup() {
      if (pkt && *pkt) av_packet_free(pkt);
      if (frame && *frame) av_frame_free(frame);
      if (swr && *swr) swr_free(swr);
      if (decCtx && *decCtx) avcodec_free_context(decCtx);
      if (fmtCtx && *fmtCtx) avformat_close_input(fmtCtx);
      if (avioCtx && *avioCtx) {
        avio_context_free(avioCtx);
      }
      if (ownedFd && *ownedFd >= 0) {
        close(*ownedFd);
        *ownedFd = -1;
      }
    }
  };
  AVCodecContext* decCtx = nullptr;
  SwrContext* swr = nullptr;
  AVFrame* frame = nullptr;
  AVPacket* pkt = nullptr;
  Cleanup cleanup{&fmtCtx, &decCtx, &swr, &frame, &pkt, &avioCtx, &ownedFd};

  // Open input from real FD when provided, otherwise from path
  if (inputFd >= 0) {
    ownedFd = dup(inputFd);
    if (ownedFd < 0) {
      throw std::runtime_error("DECODE_NOT_FOUND: Cannot duplicate input fd");
    }

    constexpr int kAvioBufferSize = 64 * 1024;
    auto* avioBuffer = static_cast<unsigned char*>(av_malloc(kAvioBufferSize));
    if (!avioBuffer) {
      throw std::runtime_error("DECODE_INTERNAL_ERROR: Failed to allocate AVIO buffer");
    }

    fdAvioContext.fd = ownedFd;
    avioCtx = avio_alloc_context(
        avioBuffer,
        kAvioBufferSize,
        0,
        &fdAvioContext,
        avioReadFromFd,
        nullptr,
        avioSeekFd);
    if (!avioCtx) {
      av_free(avioBuffer);
      throw std::runtime_error("DECODE_INTERNAL_ERROR: Failed to allocate AVIO context");
    }

    fmtCtx = avformat_alloc_context();
    if (!fmtCtx) {
      throw std::runtime_error("DECODE_INTERNAL_ERROR: Failed to allocate format context");
    }
    fmtCtx->pb = avioCtx;
    fmtCtx->flags |= AVFMT_FLAG_CUSTOM_IO;

    const auto openResult = openGuardedFdFormatInput(
        &fmtCtx, path, "DECODE", config.allowDemuxerAutoProbe);
    if (!openResult.ok) {
      throw std::runtime_error(openResult.errorMessage);
    }
  } else {
    if (!path || path[0] == '\0') {
      throw std::runtime_error("DECODE_NOT_FOUND: Empty file path");
    }

    const auto openResult = openGuardedFormatInput(
        &fmtCtx, path, "DECODE", config.allowDemuxerAutoProbe);
    if (!openResult.ok) {
      throw std::runtime_error(openResult.errorMessage);
    }
  }

  if (avformat_find_stream_info(fmtCtx, nullptr) < 0) {
    throw std::runtime_error("DECODE_OPEN_FAILED: Failed to find stream info");
  }

  // Find audio stream
  int audioIdx = -1;
  for (unsigned i = 0; i < fmtCtx->nb_streams; ++i) {
    if (fmtCtx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
      audioIdx = (int)i;
      break;
    }
  }
  if (audioIdx < 0) {
    throw std::runtime_error("DECODE_NO_AUDIO_STREAM: No audio stream found");
  }

  AVStream* stream = fmtCtx->streams[audioIdx];
  const AVCodec* decoder = avcodec_find_decoder(stream->codecpar->codec_id);
  if (!decoder) {
    throw std::runtime_error("DECODE_CODEC_UNSUPPORTED: Unsupported audio codec");
  }

  decCtx = avcodec_alloc_context3(decoder);
  if (!decCtx) {
    throw std::runtime_error("DECODE_INTERNAL_ERROR: Failed to allocate decoder context");
  }
  if (avcodec_parameters_to_context(decCtx, stream->codecpar) < 0) {
    throw std::runtime_error("DECODE_INTERNAL_ERROR: Failed to copy codec parameters");
  }
  if (avcodec_open2(decCtx, decoder, nullptr) < 0) {
    throw std::runtime_error("DECODE_CODEC_UNSUPPORTED: Failed to open decoder");
  }

  // Source info
  int srcSampleRate = decCtx->sample_rate;
  int srcChannels = decCtx->ch_layout.nb_channels;
  if (srcChannels <= 0) srcChannels = 1;

  if (onStreamInfo) {
    onStreamInfo(srcSampleRate, srcChannels);
  }

  // Target config
  int outSampleRate = config.targetSampleRate > 0 ? config.targetSampleRate : srcSampleRate;
  int outChannels = config.forceMono ? 1 : srcChannels;

  // Configure SwrContext for resampling + downmix → float32 mono output
  AVChannelLayout outLayout;
  av_channel_layout_default(&outLayout, outChannels);

  int swrRet = swr_alloc_set_opts2(
      &swr,
      &outLayout, AV_SAMPLE_FMT_FLT, outSampleRate,
      &decCtx->ch_layout, decCtx->sample_fmt, srcSampleRate,
      0, nullptr
  );
  if (swrRet < 0 || !swr || swr_init(swr) < 0) {
    throw std::runtime_error("DECODE_RESAMPLE_ERROR: Failed to initialize resampler");
  }

  // Progress estimation
  int64_t totalFramesEstimate = 0;
  if (fmtCtx->duration > 0) {
    double durationSec = (double)fmtCtx->duration / AV_TIME_BASE;
    totalFramesEstimate = (int64_t)(durationSec * outSampleRate);
  } else if (fmtCtx->bit_rate > 0) {
    struct stat st;
    const bool hasSize =
        (ownedFd >= 0 && fstat(ownedFd, &st) == 0 && st.st_size > 0) ||
        (ownedFd < 0 && path && stat(path, &st) == 0 && st.st_size > 0);
    if (hasSize) {
      double durationSec = (double)(st.st_size * 8) / (double)fmtCtx->bit_rate;
      totalFramesEstimate = (int64_t)(durationSec * outSampleRate);
    }
  }

  frame = av_frame_alloc();
  pkt = av_packet_alloc();
  if (!frame || !pkt) {
    throw std::runtime_error("DECODE_INTERNAL_ERROR: Failed to allocate frame/packet");
  }

  int chunkSize = config.chunkSize > 0 ? config.chunkSize : 8192;
  std::vector<float> chunkBuf;
  chunkBuf.reserve(chunkSize * 2);

  int64_t totalFramesDecoded = 0;

  // Decode loop
  while (av_read_frame(fmtCtx, pkt) >= 0) {
    if (cancelFlag.load(std::memory_order_relaxed)) {
      throw std::runtime_error("DECODE_CANCELLED: Operation cancelled");
    }

    if (pkt->stream_index != audioIdx) {
      av_packet_unref(pkt);
      continue;
    }

    int sendRet = avcodec_send_packet(decCtx, pkt);
    av_packet_unref(pkt);
    if (sendRet < 0 && sendRet != AVERROR(EAGAIN) && sendRet != AVERROR_EOF) {
      throw std::runtime_error("DECODE_DECODE_ERROR: Error sending packet to decoder");
    }

    while (true) {
      int recvRet = avcodec_receive_frame(decCtx, frame);
      if (recvRet == AVERROR(EAGAIN) || recvRet == AVERROR_EOF) break;
      if (recvRet < 0) {
        throw std::runtime_error("DECODE_DECODE_ERROR: Error receiving frame from decoder");
      }

      // Resample frame → float32
      int maxOutSamples = swr_get_out_samples(swr, frame->nb_samples);
      if (maxOutSamples <= 0) maxOutSamples = frame->nb_samples * 4;

      std::vector<float> resampledBuf(maxOutSamples * outChannels);
      uint8_t* outBuf[1] = { reinterpret_cast<uint8_t*>(resampledBuf.data()) };
      const uint8_t* const* inBuf = (const uint8_t* const*)frame->extended_data;

      int converted = swr_convert(swr, outBuf, maxOutSamples, inBuf, frame->nb_samples);
      if (converted < 0) {
        throw std::runtime_error("DECODE_RESAMPLE_ERROR: Resampling failed");
      }

      // Accumulate into chunk buffer
      int samplesOut = converted * outChannels;
      chunkBuf.insert(chunkBuf.end(), resampledBuf.data(), resampledBuf.data() + samplesOut);

      // Deliver full chunks
      while ((int)chunkBuf.size() >= chunkSize) {
        onChunk(chunkBuf.data(), chunkSize);
        totalFramesDecoded += chunkSize;
        chunkBuf.erase(chunkBuf.begin(), chunkBuf.begin() + chunkSize);

        if (onProgress) {
          int pct = totalFramesEstimate > 0
            ? (int)std::min<int64_t>(100, (totalFramesDecoded * 100) / totalFramesEstimate)
            : 0;
          onProgress(totalFramesDecoded, totalFramesEstimate, pct);
        }
      }

      av_frame_unref(frame);
    }
  }

  // Flush decoder
  avcodec_send_packet(decCtx, nullptr);
  while (true) {
    int recvRet = avcodec_receive_frame(decCtx, frame);
    if (recvRet == AVERROR(EAGAIN) || recvRet == AVERROR_EOF) break;
    if (recvRet < 0) break;

    int maxOutSamples = swr_get_out_samples(swr, frame->nb_samples);
    if (maxOutSamples <= 0) maxOutSamples = frame->nb_samples * 4;

    std::vector<float> resampledBuf(maxOutSamples * outChannels);
    uint8_t* outBuf[1] = { reinterpret_cast<uint8_t*>(resampledBuf.data()) };
    const uint8_t* const* inBuf = (const uint8_t* const*)frame->extended_data;

    int converted = swr_convert(swr, outBuf, maxOutSamples, inBuf, frame->nb_samples);
    if (converted > 0) {
      int samplesOut = converted * outChannels;
      chunkBuf.insert(chunkBuf.end(), resampledBuf.data(), resampledBuf.data() + samplesOut);
    }
    av_frame_unref(frame);
  }

  // Flush resampler
  while (true) {
    float flushBuf[1024];
    uint8_t* outBuf[1] = { reinterpret_cast<uint8_t*>(flushBuf) };
    int flushed = swr_convert(swr, outBuf, 1024, nullptr, 0);
    if (flushed <= 0) break;
    int samplesOut = flushed * outChannels;
    chunkBuf.insert(chunkBuf.end(), flushBuf, flushBuf + samplesOut);
  }

  // Deliver remaining samples
  if (!chunkBuf.empty()) {
    onChunk(chunkBuf.data(), (int)chunkBuf.size());
    totalFramesDecoded += (int)chunkBuf.size();
  }

  if (onProgress && totalFramesDecoded > 0) {
    onProgress(totalFramesDecoded, totalFramesDecoded, 100);
  }

  AudioDecodeResult result;
  result.totalFramesDecoded = totalFramesDecoded;
  result.sourceSampleRate = srcSampleRate;
  result.sourceChannels = srcChannels;
  return result;
}

AudioFileProbeResult probeFileDurationFFmpeg(const char* path, int inputFd) {
  AVFormatContext* fmtCtx = nullptr;
  AVIOContext* avioCtx = nullptr;
  int ownedFd = -1;
  FdAvioContext fdAvioContext{};

  struct ProbeCleanup {
    AVFormatContext** fmtCtx;
    AVIOContext** avioCtx;
    int* ownedFd;
    ~ProbeCleanup() {
      if (fmtCtx && *fmtCtx) avformat_close_input(fmtCtx);
      if (avioCtx && *avioCtx) avio_context_free(avioCtx);
      if (ownedFd && *ownedFd >= 0) {
        close(*ownedFd);
        *ownedFd = -1;
      }
    }
  };
  ProbeCleanup cleanup{&fmtCtx, &avioCtx, &ownedFd};

  if (inputFd >= 0) {
    ownedFd = dup(inputFd);
    if (ownedFd < 0) {
      throw std::runtime_error("PROBE_NOT_FOUND: Cannot duplicate input fd");
    }
    fdAvioContext.fd = ownedFd;

    const int avioBufferSize = 32768;
    uint8_t* avioBuffer = static_cast<uint8_t*>(av_malloc(avioBufferSize));
    if (!avioBuffer) {
      throw std::runtime_error("PROBE_INTERNAL_ERROR: Failed to allocate AVIO buffer");
    }

    avioCtx = avio_alloc_context(
        avioBuffer, avioBufferSize, 0, &fdAvioContext, avioReadFromFd, nullptr, avioSeekFd);
    if (!avioCtx) {
      av_free(avioBuffer);
      throw std::runtime_error("PROBE_INTERNAL_ERROR: Failed to create AVIO context");
    }

    fmtCtx = avformat_alloc_context();
    if (!fmtCtx) {
      throw std::runtime_error("PROBE_INTERNAL_ERROR: Failed to allocate format context");
    }
    fmtCtx->pb = avioCtx;

    const auto openResult = openGuardedFdFormatInput(&fmtCtx, path, "PROBE");
    if (!openResult.ok) {
      throw std::runtime_error(openResult.errorMessage);
    }
  } else {
    const auto openResult = openGuardedFormatInput(&fmtCtx, path, "PROBE");
    if (!openResult.ok) {
      throw std::runtime_error(openResult.errorMessage);
    }
  }

  AVDictionary* opts = nullptr;
  av_dict_set(&opts, "analyzeduration", "2000000", 0);
  av_dict_set(&opts, "probesize", "32768", 0);
  if (avformat_find_stream_info(fmtCtx, &opts) < 0) {
    av_dict_free(&opts);
    throw std::runtime_error("PROBE_STREAM_INFO_FAILED: Cannot read stream info");
  }
  av_dict_free(&opts);

  int audioStreamIdx = -1;
  for (unsigned i = 0; i < fmtCtx->nb_streams; i++) {
    if (fmtCtx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
      audioStreamIdx = static_cast<int>(i);
      break;
    }
  }
  if (audioStreamIdx < 0) {
    throw std::runtime_error("PROBE_NO_AUDIO_STREAM: No audio stream found");
  }

  AudioFileProbeResult result;
  AVStream* stream = fmtCtx->streams[audioStreamIdx];
  if (stream->duration != AV_NOPTS_VALUE && stream->duration > 0 &&
      stream->time_base.num > 0) {
    const double sec = stream->duration * av_q2d(stream->time_base);
    if (sec > 0) {
      result.durationMs = static_cast<int64_t>(sec * 1000.0);
      result.isExact = true;
      return result;
    }
  }

  if (fmtCtx->duration > 0) {
    const double sec = static_cast<double>(fmtCtx->duration) / AV_TIME_BASE;
    if (sec > 0) {
      result.durationMs = static_cast<int64_t>(sec * 1000.0);
      result.isExact = true;
      return result;
    }
  }

  if (fmtCtx->bit_rate > 0) {
    struct stat st;
    const bool hasSize =
        (ownedFd >= 0 && fstat(ownedFd, &st) == 0 && st.st_size > 0) ||
        (ownedFd < 0 && path && stat(path, &st) == 0 && st.st_size > 0);
    if (hasSize) {
      const double sec =
          static_cast<double>(st.st_size * 8) / static_cast<double>(fmtCtx->bit_rate);
      if (sec > 0) {
        result.durationMs = static_cast<int64_t>(sec * 1000.0);
        result.isExact = false;
        return result;
      }
    }
  }

  throw std::runtime_error("PROBE_DURATION_UNKNOWN: Could not determine duration");
}

AudioContainerProbeResult probeFileContainerFFmpeg(const char* path, int inputFd) {
  AVFormatContext* fmtCtx = nullptr;
  AVIOContext* avioCtx = nullptr;
  int ownedFd = -1;
  FdAvioContext fdAvioContext{};

  struct ProbeCleanup {
    AVFormatContext** fmtCtx;
    AVIOContext** avioCtx;
    int* ownedFd;
    ~ProbeCleanup() {
      if (fmtCtx && *fmtCtx) avformat_close_input(fmtCtx);
      if (avioCtx && *avioCtx) avio_context_free(avioCtx);
      if (ownedFd && *ownedFd >= 0) {
        close(*ownedFd);
        *ownedFd = -1;
      }
    }
  };
  ProbeCleanup cleanup{&fmtCtx, &avioCtx, &ownedFd};

  constexpr bool kAllowDemuxerAutoProbe = true;

  if (inputFd >= 0) {
    ownedFd = dup(inputFd);
    if (ownedFd < 0) {
      throw std::runtime_error("PROBE_NOT_FOUND: Cannot duplicate input fd");
    }
    fdAvioContext.fd = ownedFd;

    const int avioBufferSize = 32768;
    uint8_t* avioBuffer = static_cast<uint8_t*>(av_malloc(avioBufferSize));
    if (!avioBuffer) {
      throw std::runtime_error("PROBE_INTERNAL_ERROR: Failed to allocate AVIO buffer");
    }

    avioCtx = avio_alloc_context(
        avioBuffer, avioBufferSize, 0, &fdAvioContext, avioReadFromFd, nullptr, avioSeekFd);
    if (!avioCtx) {
      av_free(avioBuffer);
      throw std::runtime_error("PROBE_INTERNAL_ERROR: Failed to create AVIO context");
    }

    fmtCtx = avformat_alloc_context();
    if (!fmtCtx) {
      throw std::runtime_error("PROBE_INTERNAL_ERROR: Failed to allocate format context");
    }
    fmtCtx->pb = avioCtx;

    const auto openResult =
        openGuardedFdFormatInput(&fmtCtx, path, "PROBE", kAllowDemuxerAutoProbe);
    if (!openResult.ok) {
      throw std::runtime_error(openResult.errorMessage);
    }
  } else {
    const auto openResult =
        openGuardedFormatInput(&fmtCtx, path, "PROBE", kAllowDemuxerAutoProbe);
    if (!openResult.ok) {
      throw std::runtime_error(openResult.errorMessage);
    }
  }

  AVDictionary* opts = nullptr;
  av_dict_set(&opts, "analyzeduration", "2000000", 0);
  av_dict_set(&opts, "probesize", "32768", 0);
  if (avformat_find_stream_info(fmtCtx, &opts) < 0) {
    av_dict_free(&opts);
    throw std::runtime_error("PROBE_STREAM_INFO_FAILED: Cannot read stream info");
  }
  av_dict_free(&opts);

  int audioStreamIdx = -1;
  for (unsigned i = 0; i < fmtCtx->nb_streams; i++) {
    if (fmtCtx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
      audioStreamIdx = static_cast<int>(i);
      break;
    }
  }
  if (audioStreamIdx < 0) {
    throw std::runtime_error("PROBE_NO_AUDIO_STREAM: No audio stream found");
  }

  AudioContainerProbeResult result;
  if (fmtCtx->iformat && fmtCtx->iformat->name && fmtCtx->iformat->name[0] != '\0') {
    result.inputFormatName = fmtCtx->iformat->name;
  } else {
    result.inputFormatName = "unknown";
  }

  const AVCodecParameters* par = fmtCtx->streams[audioStreamIdx]->codecpar;
  if (par) {
    const AVCodec* decoder = avcodec_find_decoder(par->codec_id);
    if (decoder && decoder->name && decoder->name[0] != '\0') {
      result.codecName = decoder->name;
    } else {
      const char* name = avcodec_get_name(par->codec_id);
      result.codecName = (name && name[0] != '\0') ? name : "unknown";
    }
  } else {
    result.codecName = "unknown";
  }

  return result;
}

} // anonymous namespace

#endif // HAVE_FFMPEG

// ==================== Public Entry Point ====================

AudioDecodeResult decodeFile(
    const char* pathOrFd,
    int inputFd,
    const AudioDecodeConfig& config,
    DecodeChunkCallback onChunk,
    DecodeProgressCallback onProgress,
    DecodeStreamInfoCallback onStreamInfo,
    std::atomic<bool>& cancelFlag
) {
  if ((!pathOrFd || pathOrFd[0] == '\0') && inputFd < 0) {
    throw std::runtime_error("DECODE_NOT_FOUND: Empty file path and invalid fd");
  }

  // Try WAV fast path first
  FILE* f = nullptr;
  if (inputFd >= 0) {
    int probeFd = dup(inputFd);
    if (probeFd < 0) {
      throw std::runtime_error("DECODE_NOT_FOUND: Cannot duplicate input fd");
    }
    f = fdopen(probeFd, "rb");
    if (!f) {
      close(probeFd);
      throw std::runtime_error("DECODE_NOT_FOUND: Cannot open input fd");
    }
  } else {
    f = fopen(pathOrFd, "rb");
    if (!f) {
      throw std::runtime_error(std::string("DECODE_NOT_FOUND: Cannot open file: ") + pathOrFd);
    }
  }

  WavInfo wavInfo = parseWavHeaderForFastPath(f);
  if (canUseWavFastPath(wavInfo, config)) {
    LOGI("Using WAV fast path: rate=%d ch=%d bits=%d", wavInfo.sampleRate, wavInfo.channels, wavInfo.bitsPerSample);
    auto result = decodeWavFastPath(f, wavInfo, config, onChunk, onProgress, onStreamInfo, cancelFlag);
    fclose(f);
    return result;
  }
  fclose(f);

  if (inputFd >= 0 && lseek(inputFd, 0, SEEK_SET) < 0) {
    throw std::runtime_error("DECODE_INVALID_SOURCE: Input fd is not seekable");
  }

  // FFmpeg path
#ifdef HAVE_FFMPEG
  LOGI("Using FFmpeg decode path: %s targetRate=%d forceMono=%d", pathOrFd ? pathOrFd : "<fd>", config.targetSampleRate, config.forceMono);
  return decodeFileFFmpeg(pathOrFd, inputFd, config, onChunk, onProgress, onStreamInfo, cancelFlag);
#else
  throw std::runtime_error("DECODE_INTERNAL_ERROR: FFmpeg not available in this build");
#endif
}

AudioFileProbeResult probeFileDuration(const char* pathOrFd, int inputFd) {
  if ((!pathOrFd || pathOrFd[0] == '\0') && inputFd < 0) {
    throw std::runtime_error("PROBE_NOT_FOUND: Empty file path and invalid fd");
  }

  auto wavResult = probeWavDuration(pathOrFd, inputFd);
  if (wavResult.durationMs >= 0) {
    return wavResult;
  }

  if (inputFd >= 0 && lseek(inputFd, 0, SEEK_SET) < 0) {
    throw std::runtime_error("PROBE_INVALID_SOURCE: Input fd is not seekable");
  }

#ifdef HAVE_FFMPEG
  return probeFileDurationFFmpeg(pathOrFd, inputFd);
#else
  throw std::runtime_error("PROBE_UNSUPPORTED: FFmpeg not available in this build");
#endif
}

AudioContainerProbeResult probeFileContainer(const char* pathOrFd, int inputFd) {
  if ((!pathOrFd || pathOrFd[0] == '\0') && inputFd < 0) {
    throw std::runtime_error("PROBE_NOT_FOUND: Empty file path and invalid fd");
  }

  auto wavResult = probeWavContainer(pathOrFd, inputFd);
  if (!wavResult.inputFormatName.empty()) {
    return wavResult;
  }

  if (inputFd >= 0 && lseek(inputFd, 0, SEEK_SET) < 0) {
    throw std::runtime_error("PROBE_INVALID_SOURCE: Input fd is not seekable");
  }

#ifdef HAVE_FFMPEG
  return probeFileContainerFFmpeg(pathOrFd, inputFd);
#else
  throw std::runtime_error("PROBE_UNSUPPORTED: FFmpeg not available in this build");
#endif
}

} // namespace sherpa
