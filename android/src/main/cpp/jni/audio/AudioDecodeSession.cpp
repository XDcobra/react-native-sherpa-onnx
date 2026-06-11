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
#include "../diagnostic/NativeDiagnostic.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdint>
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

#ifndef NDEBUG
#define AUDIO_DECODE_DBG(...) LOGI(__VA_ARGS__)
#define AUDIO_DECODE_DBGW(...) LOGW(__VA_ARGS__)
#else
#define AUDIO_DECODE_DBG(...) ((void)0)
#define AUDIO_DECODE_DBGW(...) ((void)0)
#endif

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libavutil/error.h>
#include <libavutil/intreadwrite.h>
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

static const int kMpeg4AacSampleRates[] = {
    96000, 88200, 64000, 48000, 44100, 32000,
    24000, 22050, 16000, 12000, 11025, 8000, 7350,
};

static const int kAdtsChannelCount[] = {0, 1, 2, 3, 4, 5, 6, 8};
static constexpr int kMinValidAdtsFrameBytes = 100;

static void logDirectFdBytes(int fd, int64_t offset, size_t count, const char* label) {
#ifndef NDEBUG
  if (fd < 0 || !label || count == 0) {
    return;
  }

  std::vector<uint8_t> buf(count);
  const ssize_t got = pread(fd, buf.data(), count, static_cast<off_t>(offset));
  if (got <= 0) {
    AUDIO_DECODE_DBGW(
        "fd_direct label=%s offset=%lld read_fail got=%zd",
        label,
        static_cast<long long>(offset),
        got);
    return;
  }

  char hex[128] = {0};
  const int hexLen = std::min(static_cast<int>(got), 32);
  for (int i = 0; i < hexLen; ++i) {
    std::snprintf(hex + i * 3, sizeof(hex) - i * 3, "%02x ", buf[i]);
  }
  AUDIO_DECODE_DBG(
      "fd_direct label=%s offset=%lld got=%zd hex=%s",
      label,
      static_cast<long long>(offset),
      got,
      hex);
#else
  (void)fd;
  (void)offset;
  (void)count;
  (void)label;
#endif
}

static int parseAdtsFrameLength(const uint8_t* hdr, int available) {
  if (available < 7) {
    return 0;
  }
  if ((AV_RB16(hdr) & 0xFFF6) != 0xFFF0) {
    return 0;
  }
  return (AV_RB32(hdr + 3) >> 13) & 0x1FFF;
}

static int64_t resyncRawAdtsToValidFrame(AVFormatContext* fmtCtx, int minFrameBytes) {
  if (!fmtCtx || !fmtCtx->pb || minFrameBytes <= 0) {
    return -1;
  }

  const int64_t fileSize = avio_size(fmtCtx->pb);
  const int64_t scanLimit = fileSize > 0 ? fileSize : (1024 * 1024);

  if (avio_seek(fmtCtx->pb, 0, SEEK_SET) < 0) {
    AUDIO_DECODE_DBGW("adts_resync seek_to_0_failed");
    return -1;
  }

  int64_t scanPos = 0;
  int candidates = 0;
  while (scanPos + 7 <= scanLimit) {
    if (avio_seek(fmtCtx->pb, scanPos, SEEK_SET) < 0) {
      break;
    }

    uint8_t hdr[7];
    const int got = avio_read(fmtCtx->pb, hdr, 7);
    if (got != 7) {
      break;
    }

    const int fsize = parseAdtsFrameLength(hdr, 7);
    if (fsize <= 0) {
      scanPos++;
      continue;
    }

    candidates++;
    char hex[32] = {0};
    for (int i = 0; i < 7; ++i) {
      std::snprintf(hex + i * 3, sizeof(hex) - i * 3, "%02x ", hdr[i]);
    }
    AUDIO_DECODE_DBG(
        "adts_candidate #%d syncPos=%lld fsize=%d min=%d hex=%s",
        candidates,
        static_cast<long long>(scanPos),
        fsize,
        minFrameBytes,
        hex);

    if (fsize >= minFrameBytes && (fileSize <= 0 || scanPos + fsize <= fileSize)) {
      avio_seek(fmtCtx->pb, scanPos, SEEK_SET);
      AUDIO_DECODE_DBG(
          "adts_resync_ok syncPos=%lld fsize=%d scanned=%lld",
          static_cast<long long>(scanPos),
          fsize,
          static_cast<long long>(scanPos));
      return scanPos;
    }

    scanPos++;
  }

  AUDIO_DECODE_DBGW(
      "adts_resync_fail candidates=%d scanLimit=%lld fileSize=%lld",
      candidates,
      static_cast<long long>(scanLimit),
      static_cast<long long>(fileSize));
  return -1;
}

struct AdtsFrameHeader {
  bool ok = false;
  int frameLength = 0;
  int sampleRateHz = 0;
  int channelCount = 0;
  int sfIndex = -1;
  int chConfig = 0;
  uint8_t bytes[7] = {};
};

static AdtsFrameHeader peekAdtsHeaderAtAvio(AVFormatContext* fmtCtx) {
  AdtsFrameHeader hdr;
  if (!fmtCtx || !fmtCtx->pb) {
    return hdr;
  }

  const int64_t syncPos = avio_tell(fmtCtx->pb);
  const int got = avio_read(fmtCtx->pb, hdr.bytes, 7);
  if (got != 7) {
    AUDIO_DECODE_DBGW("adts_peek read_fail syncPos=%lld got=%d", static_cast<long long>(syncPos), got);
    avio_seek(fmtCtx->pb, syncPos, SEEK_SET);
    return hdr;
  }

  if ((AV_RB16(hdr.bytes) & 0xFFF6) != 0xFFF0) {
    char hex[32] = {0};
    for (int i = 0; i < 7; ++i) {
      std::snprintf(hex + i * 3, sizeof(hex) - i * 3, "%02x ", hdr.bytes[i]);
    }
    AUDIO_DECODE_DBGW(
        "adts_peek sync_miss syncPos=%lld hex=%s",
        static_cast<long long>(syncPos),
        hex);
    avio_seek(fmtCtx->pb, syncPos, SEEK_SET);
    return hdr;
  }

  hdr.sfIndex = (hdr.bytes[2] & 0x3C) >> 2;
  hdr.chConfig = ((hdr.bytes[2] & 0x01) << 2) | ((hdr.bytes[3] & 0xC0) >> 6);
  hdr.frameLength = (AV_RB32(hdr.bytes + 3) >> 13) & 0x1FFF;
  if (hdr.sfIndex >= 0 && hdr.sfIndex < static_cast<int>(sizeof(kMpeg4AacSampleRates) / sizeof(kMpeg4AacSampleRates[0]))) {
    hdr.sampleRateHz = kMpeg4AacSampleRates[hdr.sfIndex];
  }
  if (hdr.chConfig >= 0 && hdr.chConfig < static_cast<int>(sizeof(kAdtsChannelCount) / sizeof(kAdtsChannelCount[0]))) {
    hdr.channelCount = kAdtsChannelCount[hdr.chConfig];
  }
  hdr.ok = hdr.sampleRateHz > 0 && hdr.frameLength >= kMinValidAdtsFrameBytes;

  const int64_t restoredPos = avio_seek(fmtCtx->pb, syncPos, SEEK_SET);
  if (restoredPos < 0) {
    AUDIO_DECODE_DBGW(
        "adts_peek restore_fail syncPos=%lld restored=%lld",
        static_cast<long long>(syncPos),
        static_cast<long long>(restoredPos));
    hdr.ok = false;
    return hdr;
  }

  char hex[32] = {0};
  for (int i = 0; i < 7; ++i) {
    std::snprintf(hex + i * 3, sizeof(hex) - i * 3, "%02x ", hdr.bytes[i]);
  }
  AUDIO_DECODE_DBG(
      "adts_peek syncPos=%lld frameLen=%d sfIdx=%d sr=%d chCfg=%d ch=%d hex=%s",
      static_cast<long long>(syncPos),
      hdr.frameLength,
      hdr.sfIndex,
      hdr.sampleRateHz,
      hdr.chConfig,
      hdr.channelCount,
      hex);
  return hdr;
}

static void logInputIoState(
    AVFormatContext* fmtCtx,
    int ownedFd,
    int inputFd,
    const char* phase) {
#ifndef NDEBUG
  int64_t avioPos = -1;
  int64_t avioSize = -1;
  int seekable = 0;
  int eofReached = -1;
  int avioError = 0;
  int64_t bytesRead = -1;
  if (fmtCtx && fmtCtx->pb) {
    avioPos = avio_tell(fmtCtx->pb);
    avioSize = avio_size(fmtCtx->pb);
    seekable = fmtCtx->pb->seekable;
    eofReached = fmtCtx->pb->eof_reached;
    avioError = fmtCtx->pb->error;
    bytesRead = fmtCtx->pb->bytes_read;
    const int bufLeft = static_cast<int>(fmtCtx->pb->buf_end - fmtCtx->pb->buf_ptr);
    const int bufTotal = static_cast<int>(fmtCtx->pb->buf_end - fmtCtx->pb->buffer);
    const int64_t bufBasePos =
        fmtCtx->pb->pos - (fmtCtx->pb->write_flag ? 0 : bufTotal);
    AUDIO_DECODE_DBG(
        "avio_detail phase=%s bufBasePos=%lld bufLeft=%d bufTotal=%d pos=%lld eof=%d avioErr=%d bytesRead=%lld",
        phase ? phase : "?",
        static_cast<long long>(bufBasePos),
        bufLeft,
        bufTotal,
        static_cast<long long>(fmtCtx->pb->pos),
        eofReached,
        avioError,
        static_cast<long long>(bytesRead));
  }

  off_t fdPos = -1;
  off_t fdSize = -1;
  if (ownedFd >= 0) {
    fdPos = lseek(ownedFd, 0, SEEK_CUR);
    fdSize = lseek(ownedFd, 0, SEEK_END);
    if (fdSize >= 0) {
      lseek(ownedFd, fdPos, SEEK_SET);
    }
  }

  AUDIO_DECODE_DBG(
      "io_state phase=%s inputFd=%d ownedFd=%d avioPos=%lld avioSize=%lld seekable=0x%x fdPos=%lld fdSize=%lld",
      phase ? phase : "?",
      inputFd,
      ownedFd,
      static_cast<long long>(avioPos),
      static_cast<long long>(avioSize),
      seekable,
      static_cast<long long>(fdPos),
      static_cast<long long>(fdSize));
#else
  (void)fmtCtx;
  (void)ownedFd;
  (void)inputFd;
  (void)phase;
#endif
}

static const char* mediaTypeName(int mediaType) {
  switch (mediaType) {
    case AVMEDIA_TYPE_AUDIO:
      return "audio";
    case AVMEDIA_TYPE_VIDEO:
      return "video";
    case AVMEDIA_TYPE_SUBTITLE:
      return "subtitle";
    case AVMEDIA_TYPE_DATA:
      return "data";
    default:
      return "other";
  }
}

static const char* identifyContainerMagic(const uint8_t* buf, size_t len) {
  if (!buf || len < 2) {
    return "too_short";
  }
  if (len >= 12 && buf[0] == 'R' && buf[1] == 'I' && buf[2] == 'F' && buf[3] == 'F' &&
      buf[8] == 'W' && buf[9] == 'A' && buf[10] == 'V' && buf[11] == 'E') {
    return "RIFF/WAVE";
  }
  if (len >= 8 && buf[4] == 'f' && buf[5] == 't' && buf[6] == 'y' && buf[7] == 'p') {
    return "ISO/ftyp";
  }
  if (len >= 3 && buf[0] == 'I' && buf[1] == 'D' && buf[2] == '3') {
    return "ID3v2";
  }
  if (len >= 4 && buf[0] == 'O' && buf[1] == 'g' && buf[2] == 'g' && buf[3] == 'S') {
    return "OggS";
  }
  if (len >= 4 && buf[0] == 'f' && buf[1] == 'L' && buf[2] == 'a' && buf[3] == 'C') {
    return "fLaC";
  }
  if (len >= 4 && buf[0] == 'F' && buf[1] == 'L' && buf[2] == 'A' && buf[3] == 'C') {
    return "FLAC";
  }
  if (len >= 2 && (buf[0] & 0xFF) == 0xFF && ((buf[1] & 0xF6) == 0xF0)) {
    return "ADTS";
  }
  if (len >= 4 && buf[0] == 0x1A && buf[1] == 'E' && buf[2] == 'B' && buf[3] == 'P') {
    return "EBML/matroska";
  }
  if (len >= 2 && (buf[0] & 0xFF) == 0xFF && ((buf[1] & 0xE0) == 0xE0)) {
    return "MP3_frame_sync";
  }
  if (len >= 4 && buf[0] == 'X' && buf[1] == 'i' && buf[2] == 'n' && buf[3] == 'g') {
    return "Xing/MP3";
  }
  if (len >= 4 && buf[0] == 'I' && buf[1] == 'n' && buf[2] == 'f' && buf[3] == 'o') {
    return "Info/MP3";
  }
  return "unknown";
}

static void logContainerMagicFromFd(int fd, const char* label) {
#ifndef NDEBUG
  if (fd < 0 || !label) {
    return;
  }

  uint8_t buf[16] = {};
  const ssize_t got = pread(fd, buf, sizeof(buf), 0);
  if (got <= 0) {
    AUDIO_DECODE_DBGW(
        "container_magic label=%s read_fail got=%zd",
        label,
        got);
    return;
  }

  char hex[64] = {0};
  const int hexLen = std::min(static_cast<int>(got), 16);
  for (int i = 0; i < hexLen; ++i) {
    std::snprintf(hex + i * 3, sizeof(hex) - i * 3, "%02x ", buf[i]);
  }
  AUDIO_DECODE_DBG(
      "container_magic label=%s magic=%s got=%zd hex=%s",
      label,
      identifyContainerMagic(buf, static_cast<size_t>(got)),
      got,
      hex);
#else
  (void)fd;
  (void)label;
#endif
}

static void logFormatContextSummary(
    AVFormatContext* fmtCtx,
    int selectedAudioIdx,
    const char* phase) {
#ifndef NDEBUG
  if (!fmtCtx) {
    return;
  }

  const char* iformat =
      (fmtCtx->iformat && fmtCtx->iformat->name) ? fmtCtx->iformat->name : "?";
  AUDIO_DECODE_DBG(
      "format_summary phase=%s iformat=%s nb_streams=%u duration=%lld bit_rate=%lld",
      phase ? phase : "?",
      iformat,
      fmtCtx->nb_streams,
      static_cast<long long>(fmtCtx->duration),
      static_cast<long long>(fmtCtx->bit_rate));

  for (unsigned i = 0; i < fmtCtx->nb_streams; ++i) {
    AVStream* st = fmtCtx->streams[i];
    if (!st || !st->codecpar) {
      continue;
    }
    AVCodecParameters* par = st->codecpar;
    const char* codecName = avcodec_get_name(par->codec_id);
    AUDIO_DECODE_DBG(
        "format_stream phase=%s idx=%u type=%s codec=%s sr=%d ch=%d extradata=%d "
        "selected_audio=%d",
        phase ? phase : "?",
        i,
        mediaTypeName(par->codec_type),
        codecName ? codecName : "?",
        par->sample_rate,
        par->ch_layout.nb_channels,
        par->extradata_size,
        static_cast<int>(i) == selectedAudioIdx ? 1 : 0);
  }
#else
  (void)fmtCtx;
  (void)selectedAudioIdx;
  (void)phase;
#endif
}

static void logStreamTimingState(AVStream* st, const char* phase) {
#ifndef NDEBUG
  if (!st) {
    return;
  }
  AUDIO_DECODE_DBG(
      "stream_timing phase=%s idx=%d start_time=%lld duration=%lld nb_frames=%lld "
      "time_base=%d/%d",
      phase ? phase : "?",
      st->index,
      static_cast<long long>(st->start_time),
      static_cast<long long>(st->duration),
      static_cast<long long>(st->nb_frames),
      st->time_base.num,
      st->time_base.den);
#else
  (void)st;
  (void)phase;
#endif
}

static const char* ffmpegErrLabel(int err, char* buf, size_t bufSize) {
  if (err == 0) {
    return "ok";
  }
  av_strerror(err, buf, bufSize);
  return buf;
}

static bool isIsoMediaDemuxer(const AVFormatContext* fmtCtx) {
  if (!fmtCtx || !fmtCtx->iformat || !fmtCtx->iformat->name) {
    return false;
  }
  // FFmpeg short name list, e.g. "mov,mp4,m4a,3gp,3g2,mj2"
  const char* name = fmtCtx->iformat->name;
  return std::strstr(name, "mov") != nullptr || std::strstr(name, "mp4") != nullptr;
}

static bool initDecodeResampler(
    SwrContext** swr,
    AVCodecContext* decCtx,
    int outSampleRate,
    int outChannels,
    int srcSampleRate,
    const char* reason) {
  if (!swr || !decCtx || srcSampleRate <= 0) {
    LOGE(
        "swr_init_skip reason=%s srcSr=%d decSr=%d decCh=%d",
        reason ? reason : "?",
        srcSampleRate,
        decCtx ? decCtx->sample_rate : 0,
        decCtx ? decCtx->ch_layout.nb_channels : 0);
    return false;
  }

  if (*swr) {
    swr_free(swr);
  }

  AVChannelLayout outLayout;
  av_channel_layout_default(&outLayout, outChannels);

  int swrRet = swr_alloc_set_opts2(
      swr,
      &outLayout,
      AV_SAMPLE_FMT_FLT,
      outSampleRate,
      &decCtx->ch_layout,
      decCtx->sample_fmt,
      srcSampleRate,
      0,
      nullptr);
  if (swrRet < 0 || !*swr) {
    char errbuf[AV_ERROR_MAX_STRING_SIZE] = {0};
    av_strerror(swrRet, errbuf, sizeof(errbuf));
    LOGE(
        "swr_alloc_fail reason=%s ret=%d (%s) outSr=%d outCh=%d inSr=%d inCh=%d inFmt=%d",
        reason ? reason : "?",
        swrRet,
        errbuf,
        outSampleRate,
        outChannels,
        srcSampleRate,
        decCtx->ch_layout.nb_channels,
        static_cast<int>(decCtx->sample_fmt));
    return false;
  }

  const int initRet = swr_init(*swr);
  if (initRet < 0) {
    char errbuf[AV_ERROR_MAX_STRING_SIZE] = {0};
    av_strerror(initRet, errbuf, sizeof(errbuf));
    LOGE(
        "swr_init_fail reason=%s ret=%d (%s) outSr=%d outCh=%d inSr=%d inCh=%d inFmt=%d",
        reason ? reason : "?",
        initRet,
        errbuf,
        outSampleRate,
        outChannels,
        srcSampleRate,
        decCtx->ch_layout.nb_channels,
        static_cast<int>(decCtx->sample_fmt));
    swr_free(swr);
    return false;
  }

  AUDIO_DECODE_DBG(
      "swr_init_ok reason=%s outSr=%d outCh=%d inSr=%d inCh=%d inFmt=%d",
      reason ? reason : "?",
      outSampleRate,
      outChannels,
      srcSampleRate,
      decCtx->ch_layout.nb_channels,
      static_cast<int>(decCtx->sample_fmt));
  return true;
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
  char diagDetail[64];
  std::snprintf(
      diagDetail,
      sizeof(diagDetail),
      "allowAutoProbe=%d",
      config.allowDemuxerAutoProbe ? 1 : 0);
  SHERPA_DIAG_D("audio.decode", "ffmpeg_start", diagDetail);
  AUDIO_DECODE_DBG(
      "ffmpeg_start pathHint=%s fd=%d allowAutoProbe=%d",
      path ? path : "(null)",
      inputFd,
      config.allowDemuxerAutoProbe ? 1 : 0);

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
      SHERPA_DIAG_D("audio.decode", "open_fail", diagDetail);
      throw std::runtime_error(openResult.errorMessage);
    }
  } else {
    if (!path || path[0] == '\0') {
      throw std::runtime_error("DECODE_NOT_FOUND: Empty file path");
    }

    const auto openResult = openGuardedFormatInput(
        &fmtCtx, path, "DECODE", config.allowDemuxerAutoProbe);
    if (!openResult.ok) {
      SHERPA_DIAG_D("audio.decode", "open_fail", diagDetail);
      throw std::runtime_error(openResult.errorMessage);
    }
  }

  const bool isRawAdtsDemuxer =
      fmtCtx->iformat && fmtCtx->iformat->name &&
      std::strcmp(fmtCtx->iformat->name, "aac") == 0;
  const char* inputKind = inputFd >= 0 ? "content_fd" : "path";
  const char* iformatName =
      (fmtCtx->iformat && fmtCtx->iformat->name) ? fmtCtx->iformat->name : "?";

  AUDIO_DECODE_DBG(
      "decode_open inputKind=%s iformat=%s rawAdts=%d pathHint=%s fd=%d",
      inputKind,
      iformatName,
      isRawAdtsDemuxer ? 1 : 0,
      path ? path : "(null)",
      inputFd);
  if (ownedFd >= 0) {
    logContainerMagicFromFd(ownedFd, "decode_open");
    logDirectFdBytes(ownedFd, 0, 32, "decode_file_start");
  }
  logInputIoState(fmtCtx, ownedFd, inputFd, "after_open");
  logFormatContextSummary(fmtCtx, -1, "after_read_header");

  // Raw ADTS: read_header already resynced to the first frame. find_stream_info
  // reads ahead and leaves the demuxer mid-stream; rewinding to byte 0 does not
  // re-run resync, so the first av_read_frame can yield a bogus 9-byte ADTS header.
  if (!isRawAdtsDemuxer) {
    logInputIoState(fmtCtx, ownedFd, inputFd, "before_find_stream_info");
    if (avformat_find_stream_info(fmtCtx, nullptr) < 0) {
      throw std::runtime_error("DECODE_OPEN_FAILED: Failed to find stream info");
    }
    logInputIoState(fmtCtx, ownedFd, inputFd, "after_find_stream_info");
    logFormatContextSummary(fmtCtx, -1, "after_find_stream_info");
  } else {
    AUDIO_DECODE_DBG("skip find_stream_info for raw ADTS demuxer (read_header resync active)");
    logInputIoState(fmtCtx, ownedFd, inputFd, "after_read_header");
    logDirectFdBytes(ownedFd, 0, 32, "adts_file_start");
    const int64_t resyncPos =
        resyncRawAdtsToValidFrame(fmtCtx, kMinValidAdtsFrameBytes);
    if (resyncPos < 0) {
      AUDIO_DECODE_DBGW("adts_resync using read_header position (no valid frame found while scanning)");
    }
    logInputIoState(fmtCtx, ownedFd, inputFd, "after_adts_resync");
  }

  AdtsFrameHeader adtsPeek;
  if (isRawAdtsDemuxer) {
    adtsPeek = peekAdtsHeaderAtAvio(fmtCtx);
    if (!adtsPeek.ok) {
      AUDIO_DECODE_DBGW(
          "adts_peek invalid after resync frameLen=%d sr=%d — decode may still recover from parser",
          adtsPeek.frameLength,
          adtsPeek.sampleRateHz);
    }
    logInputIoState(fmtCtx, ownedFd, inputFd, "after_adts_peek");
  }

  // Find audio stream before rewinding custom inputs (seek may target this stream).
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
  logFormatContextSummary(fmtCtx, audioIdx, "stream_selected");

  // Custom AVIO (e.g. Android content:// fd): reset read position after probe.
  // ISO-BMFF (mov/mp4/m4a): NEVER avio_seek(0). FFmpeg mov_read_packet() at pb->pos==0
  // discards all index entries and re-parses from scratch — yields EOF on custom AVIO.
  // Keep post-find_stream_info IO position; only stream-index seek to sample 0.
  if (!isRawAdtsDemuxer && inputFd >= 0 && fmtCtx->pb != nullptr) {
    char errbuf[AV_ERROR_MAX_STRING_SIZE] = {0};
    const bool isoMedia = isIsoMediaDemuxer(fmtCtx);

    if (isoMedia) {
      const int64_t avioPosBeforeSeek = avio_tell(fmtCtx->pb);
      int streamSeekRet = -1;
      if (audioIdx >= 0) {
        streamSeekRet = av_seek_frame(fmtCtx, audioIdx, 0, AVSEEK_FLAG_BACKWARD);
        if (streamSeekRet < 0) {
          streamSeekRet = avformat_seek_file(
              fmtCtx,
              audioIdx,
              INT64_MIN,
              0,
              INT64_MAX,
              AVSEEK_FLAG_BACKWARD);
        }
      }
      AUDIO_DECODE_DBG(
          "iso_custom_fd_seek streamSeekRet=%d (%s) avioPosBefore=%lld avioPosAfter=%lld "
          "(must stay !=0)",
          streamSeekRet,
          ffmpegErrLabel(streamSeekRet, errbuf, sizeof(errbuf)),
          static_cast<long long>(avioPosBeforeSeek),
          fmtCtx->pb ? static_cast<long long>(avio_tell(fmtCtx->pb)) : -1LL);
      if (streamSeekRet < 0) {
        throw std::runtime_error(
            "DECODE_OPEN_FAILED: Failed to seek ISO media stream to start on custom input");
      }
      logInputIoState(fmtCtx, ownedFd, inputFd, "after_iso_stream_seek");
      if (audioIdx >= 0 && fmtCtx->streams[audioIdx]) {
        logStreamTimingState(fmtCtx->streams[audioIdx], "after_iso_stream_seek");
      }
    } else {
      const int64_t avioSeekRet = avio_seek(fmtCtx->pb, 0, SEEK_SET);
      AUDIO_DECODE_DBG(
          "rewind_step avio_seek ret=%lld eof_before=%d",
          static_cast<long long>(avioSeekRet),
          fmtCtx->pb->eof_reached);
      logInputIoState(fmtCtx, ownedFd, inputFd, "after_avio_seek_0");

      const int byteSeekRet =
          avformat_seek_file(fmtCtx, -1, 0, 0, 0, AVSEEK_FLAG_BYTE);
      AUDIO_DECODE_DBG(
          "rewind_step byte_seek ret=%d (%s)",
          byteSeekRet,
          ffmpegErrLabel(byteSeekRet, errbuf, sizeof(errbuf)));
      logInputIoState(fmtCtx, ownedFd, inputFd, "after_byte_seek");

      int streamSeekRet = -1;
      if (byteSeekRet < 0 && audioIdx >= 0) {
        streamSeekRet = avformat_seek_file(fmtCtx, audioIdx, 0, 0, 0, 0);
        AUDIO_DECODE_DBG(
            "rewind_step stream_seek_fallback ret=%d (%s) audioIdx=%d",
            streamSeekRet,
            ffmpegErrLabel(streamSeekRet, errbuf, sizeof(errbuf)),
            audioIdx);
        logInputIoState(fmtCtx, ownedFd, inputFd, "after_stream_seek_fallback");
      }

      AUDIO_DECODE_DBG(
          "rewind_after_probe fd=%d avioSeekRet=%lld byteSeekRet=%d streamSeekRet=%d audioIdx=%d",
          inputFd,
          static_cast<long long>(avioSeekRet),
          byteSeekRet,
          streamSeekRet,
          audioIdx);
      if (avioSeekRet < 0) {
        throw std::runtime_error(
            "DECODE_OPEN_FAILED: Failed to rewind custom input after stream probe");
      }
      if (byteSeekRet < 0 && streamSeekRet < 0) {
        throw std::runtime_error(
            "DECODE_OPEN_FAILED: Failed to seek custom input after stream probe");
      }
      if (audioIdx >= 0 && fmtCtx->streams[audioIdx]) {
        logStreamTimingState(fmtCtx->streams[audioIdx], "after_rewind_after_probe");
      }
      if (ownedFd >= 0) {
        logDirectFdBytes(ownedFd, 0, 32, "after_rewind_file_start");
        logDirectFdBytes(ownedFd, avio_tell(fmtCtx->pb), 32, "after_rewind_avio_pos");
      }
      logInputIoState(fmtCtx, ownedFd, inputFd, "after_rewind_after_probe");
    }
    logFormatContextSummary(fmtCtx, audioIdx, "after_rewind_after_probe");
  } else if (!isRawAdtsDemuxer && inputFd < 0) {
    AUDIO_DECODE_DBG("rewind_after_probe skipped inputKind=path iformat=%s", iformatName);
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

  // Source info — raw ADTS leaves codecpar empty until packets are parsed.
  int srcSampleRate = decCtx->sample_rate;
  int srcChannels = decCtx->ch_layout.nb_channels;
  if (isRawAdtsDemuxer && adtsPeek.ok) {
    if (srcSampleRate <= 0) {
      srcSampleRate = adtsPeek.sampleRateHz;
    }
    if (srcChannels <= 0 && adtsPeek.channelCount > 0) {
      srcChannels = adtsPeek.channelCount;
      av_channel_layout_uninit(&decCtx->ch_layout);
      av_channel_layout_default(&decCtx->ch_layout, srcChannels);
    }
    if (stream->codecpar->bit_rate <= 0 && adtsPeek.frameLength > 0 && srcSampleRate > 0) {
      stream->codecpar->bit_rate =
          static_cast<int64_t>(adtsPeek.frameLength) * 8LL * srcSampleRate / 1024LL;
    }
  }
  if (srcChannels <= 0) srcChannels = 1;

  if (onStreamInfo) {
    onStreamInfo(srcSampleRate, srcChannels);
  }

  AUDIO_DECODE_DBG(
      "decode_stream_open inputKind=%s iformat=%s codec=%s profile=%d sample_fmt=%d sr=%d ch=%d "
      "extradata=%d bit_rate=%lld adtsPeek=%d pathHint=%s fd=%d",
      inputKind,
      iformatName,
      decoder->name ? decoder->name : "?",
      stream->codecpar->profile,
      static_cast<int>(decCtx->sample_fmt),
      srcSampleRate,
      srcChannels,
      stream->codecpar->extradata_size,
      static_cast<long long>(stream->codecpar->bit_rate),
      adtsPeek.ok ? 1 : 0,
      path ? path : "(null)",
      inputFd);

  // Target config
  int outSampleRate = config.targetSampleRate > 0 ? config.targetSampleRate : srcSampleRate;
  int outChannels = config.forceMono ? 1 : srcChannels;

  bool swrReady = false;
  if (srcSampleRate > 0) {
    swrReady = initDecodeResampler(
        &swr,
        decCtx,
        outSampleRate,
        outChannels,
        srcSampleRate,
        isRawAdtsDemuxer ? "adts_peek" : "codecpar");
    if (!swrReady) {
      throw std::runtime_error("DECODE_RESAMPLE_ERROR: Failed to initialize resampler");
    }
  } else {
    AUDIO_DECODE_DBG(
        "swr_init_deferred iformat=%s waiting_for_first_decoded_frame",
        iformatName);
  }

  auto ensureSwrFromFrame = [&](AVFrame* decodedFrame, const char* reason) {
    if (swrReady) {
      return;
    }
    int frameSampleRate = decodedFrame->sample_rate > 0 ? decodedFrame->sample_rate : decCtx->sample_rate;
    if (frameSampleRate <= 0) {
      throw std::runtime_error("DECODE_RESAMPLE_ERROR: Unknown source sample rate after first frame");
    }
    if (decodedFrame->ch_layout.nb_channels > 0) {
      srcChannels = decodedFrame->ch_layout.nb_channels;
      av_channel_layout_uninit(&decCtx->ch_layout);
      av_channel_layout_copy(&decCtx->ch_layout, &decodedFrame->ch_layout);
    }
    srcSampleRate = frameSampleRate;
    if (config.targetSampleRate <= 0) {
      outSampleRate = srcSampleRate;
    }
    outChannels = config.forceMono ? 1 : srcChannels;
    if (onStreamInfo) {
      onStreamInfo(srcSampleRate, srcChannels);
    }
    AUDIO_DECODE_DBG(
        "swr_params_from_frame reason=%s sr=%d ch=%d sample_fmt=%d",
        reason ? reason : "?",
        srcSampleRate,
        srcChannels,
        static_cast<int>(decodedFrame->format));
    if (!initDecodeResampler(
            &swr,
            decCtx,
            outSampleRate,
            outChannels,
            srcSampleRate,
            reason)) {
      throw std::runtime_error("DECODE_RESAMPLE_ERROR: Failed to initialize resampler");
    }
    swrReady = true;
  };

  // Progress estimation
  int64_t totalFramesEstimate = 0;
  if (fmtCtx->duration > 0) {
    double durationSec = (double)fmtCtx->duration / AV_TIME_BASE;
    totalFramesEstimate = (int64_t)(durationSec * outSampleRate);
  } else {
    const int64_t bitRate =
        stream->codecpar->bit_rate > 0 ? stream->codecpar->bit_rate : fmtCtx->bit_rate;
    if (bitRate > 0) {
      struct stat st;
      const bool hasSize =
          (ownedFd >= 0 && fstat(ownedFd, &st) == 0 && st.st_size > 0) ||
          (ownedFd < 0 && path && stat(path, &st) == 0 && st.st_size > 0);
      if (hasSize) {
        double durationSec = (double)(st.st_size * 8) / (double)bitRate;
        totalFramesEstimate = (int64_t)(durationSec * outSampleRate);
      }
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
  int audioPacketsSeen = 0;
  int audioFramesSeen = 0;
  int readAttempts = 0;
  int nonAudioPackets = 0;
  int firstReadRet = 0;

  logInputIoState(fmtCtx, ownedFd, inputFd, "before_read_loop");
  if (audioIdx >= 0 && fmtCtx->streams[audioIdx]) {
    logStreamTimingState(fmtCtx->streams[audioIdx], "before_read_loop");
  }

  // Decode loop
  while (true) {
    const int readRet = av_read_frame(fmtCtx, pkt);
    readAttempts++;
    if (readRet < 0) {
      firstReadRet = readRet;
      char errbuf[AV_ERROR_MAX_STRING_SIZE] = {0};
      AUDIO_DECODE_DBG(
          "read_frame_end attempt=%d ret=%d (%s) audioPackets=%d nonAudio=%d avioPos=%lld eof=%d",
          readAttempts,
          readRet,
          ffmpegErrLabel(readRet, errbuf, sizeof(errbuf)),
          audioPacketsSeen,
          nonAudioPackets,
          fmtCtx->pb ? static_cast<long long>(avio_tell(fmtCtx->pb)) : -1LL,
          fmtCtx->pb ? fmtCtx->pb->eof_reached : -1);
      if (readAttempts == 1) {
        logInputIoState(fmtCtx, ownedFd, inputFd, "first_read_fail");
        if (audioIdx >= 0 && fmtCtx->streams[audioIdx]) {
          logStreamTimingState(fmtCtx->streams[audioIdx], "first_read_fail");
        }
      }
      break;
    }

    if (cancelFlag.load(std::memory_order_relaxed)) {
      av_packet_unref(pkt);
      throw std::runtime_error("DECODE_CANCELLED: Operation cancelled");
    }

    if (pkt->stream_index != audioIdx) {
      nonAudioPackets++;
      if (nonAudioPackets == 1) {
        AUDIO_DECODE_DBG(
            "first_non_audio_packet stream_index=%d expected=%d size=%d pts=%lld",
            pkt->stream_index,
            audioIdx,
            pkt->size,
            static_cast<long long>(pkt->pts));
      }
      av_packet_unref(pkt);
      continue;
    }

    audioPacketsSeen++;
    const int pktSize = pkt->size;
    if (audioPacketsSeen == 1) {
      char hexPrefix[64] = {0};
      const int hexLen = pktSize > 0 && pkt->data != nullptr ? std::min(pktSize, 16) : 0;
      for (int i = 0; i < hexLen; ++i) {
        std::snprintf(hexPrefix + i * 3, sizeof(hexPrefix) - i * 3, "%02x ", pkt->data[i]);
      }
      AUDIO_DECODE_DBG(
          "first_audio_packet iformat=%s pktSize=%d hex=%s avioPos=%lld fd=%d",
          iformatName,
          pktSize,
          hexLen > 0 ? hexPrefix : "(empty)",
          fmtCtx->pb ? static_cast<long long>(avio_tell(fmtCtx->pb)) : -1LL,
          inputFd);
    }
    int sendRet = avcodec_send_packet(decCtx, pkt);
    if (sendRet < 0 && sendRet != AVERROR(EAGAIN) && sendRet != AVERROR_EOF) {
#ifdef HAVE_FFMPEG
      char errbuf[AV_ERROR_MAX_STRING_SIZE] = {0};
      av_strerror(sendRet, errbuf, sizeof(errbuf));
      char hexPrefix[64] = {0};
      const int hexLen = pktSize > 0 && pkt->data != nullptr ? std::min(pktSize, 16) : 0;
      for (int i = 0; i < hexLen; ++i) {
        std::snprintf(hexPrefix + i * 3, sizeof(hexPrefix) - i * 3, "%02x ", pkt->data[i]);
      }
      LOGE(
          "send_packet_fail pkt#=%d ret=%d (%s) pktSize=%d hex=%s codec=%s iformat=%s pathHint=%s fd=%d",
          audioPacketsSeen,
          sendRet,
          errbuf,
          pktSize,
          hexLen > 0 ? hexPrefix : "(empty)",
          decoder->name ? decoder->name : "?",
          (fmtCtx->iformat && fmtCtx->iformat->name) ? fmtCtx->iformat->name : "?",
          path ? path : "(null)",
          inputFd);
#else
      LOGE(
          "send_packet_fail pkt#=%d ret=%d pktSize=%d pathHint=%s fd=%d",
          audioPacketsSeen,
          sendRet,
          pktSize,
          path ? path : "(null)",
          inputFd);
#endif
      av_packet_unref(pkt);
      throw std::runtime_error("DECODE_DECODE_ERROR: Error sending packet to decoder");
    }
    av_packet_unref(pkt);

    while (true) {
      int recvRet = avcodec_receive_frame(decCtx, frame);
      if (recvRet == AVERROR(EAGAIN) || recvRet == AVERROR_EOF) break;
      if (recvRet < 0) {
        throw std::runtime_error("DECODE_DECODE_ERROR: Error receiving frame from decoder");
      }

      ensureSwrFromFrame(frame, "decode_loop");

      audioFramesSeen++;
      if (audioFramesSeen == 1) {
        AUDIO_DECODE_DBG(
            "first_audio_frame iformat=%s pkt#=%d nb_samples=%d sr=%d ch=%d fmt=%d pts=%lld",
            iformatName,
            audioPacketsSeen,
            frame->nb_samples,
            frame->sample_rate,
            frame->ch_layout.nb_channels,
            static_cast<int>(frame->format),
            static_cast<long long>(frame->pts));
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

    ensureSwrFromFrame(frame, "decoder_flush");
    if (!swrReady) {
      break;
    }

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
  if (swrReady) {
    while (true) {
      float flushBuf[1024];
      uint8_t* outBuf[1] = { reinterpret_cast<uint8_t*>(flushBuf) };
      int flushed = swr_convert(swr, outBuf, 1024, nullptr, 0);
      if (flushed <= 0) break;
      int samplesOut = flushed * outChannels;
      chunkBuf.insert(chunkBuf.end(), flushBuf, flushBuf + samplesOut);
    }
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
  AUDIO_DECODE_DBG(
      "decode_done inputKind=%s iformat=%s totalFrames=%lld audioPackets=%d audioFrames=%d "
      "readAttempts=%d firstReadRet=%d nonAudio=%d outSr=%d srcSr=%d srcCh=%d pathHint=%s fd=%d",
      inputKind,
      iformatName,
      static_cast<long long>(totalFramesDecoded),
      audioPacketsSeen,
      audioFramesSeen,
      readAttempts,
      firstReadRet,
      nonAudioPackets,
      outSampleRate,
      srcSampleRate,
      srcChannels,
      path ? path : "(null)",
      inputFd);
#ifdef NDEBUG
  if (totalFramesDecoded <= 0) {
    LOGW(
        "decode_empty iformat=%s inputKind=%s pathHint=%s fd=%d packets=%d firstReadRet=%d",
        iformatName,
        inputKind,
        path ? path : "(null)",
        inputFd,
        audioPacketsSeen,
        firstReadRet);
  }
#endif
  SHERPA_DIAG("audio.decode", "ffmpeg_end");
  return result;
}

AudioFileProbeResult probeFileDurationFFmpeg(const char* path, int inputFd) {
  AUDIO_DECODE_DBG(
      "probe_duration_start pathHint=%s fd=%d inputKind=%s",
      path ? path : "(null)",
      inputFd,
      inputFd >= 0 ? "content_fd" : "path");

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

  const char* iformatName =
      (fmtCtx->iformat && fmtCtx->iformat->name) ? fmtCtx->iformat->name : "?";
  AUDIO_DECODE_DBG(
      "probe_duration_open iformat=%s pathHint=%s fd=%d",
      iformatName,
      path ? path : "(null)",
      inputFd);
  if (ownedFd >= 0) {
    logContainerMagicFromFd(ownedFd, "probe_duration_open");
    logDirectFdBytes(ownedFd, 0, 32, "probe_duration_file_start");
  }
  logInputIoState(fmtCtx, ownedFd, inputFd, "probe_duration_after_open");

  AVDictionary* opts = nullptr;
  av_dict_set(&opts, "analyzeduration", "2000000", 0);
  av_dict_set(&opts, "probesize", "32768", 0);
  if (avformat_find_stream_info(fmtCtx, &opts) < 0) {
    av_dict_free(&opts);
    throw std::runtime_error("PROBE_STREAM_INFO_FAILED: Cannot read stream info");
  }
  av_dict_free(&opts);
  logInputIoState(fmtCtx, ownedFd, inputFd, "probe_duration_after_find_stream_info");
  logFormatContextSummary(fmtCtx, -1, "probe_duration_after_find_stream_info");

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
  logFormatContextSummary(fmtCtx, audioStreamIdx, "probe_duration_stream_selected");

  AudioFileProbeResult result;
  AVStream* stream = fmtCtx->streams[audioStreamIdx];
  if (stream->duration != AV_NOPTS_VALUE && stream->duration > 0 &&
      stream->time_base.num > 0) {
    const double sec = stream->duration * av_q2d(stream->time_base);
    if (sec > 0) {
      result.durationMs = static_cast<int64_t>(sec * 1000.0);
      result.isExact = true;
      AUDIO_DECODE_DBG(
          "probe_duration_ok source=stream durationMs=%lld exact=%d iformat=%s fd=%d",
          static_cast<long long>(result.durationMs),
          result.isExact ? 1 : 0,
          iformatName,
          inputFd);
      return result;
    }
  }

  if (fmtCtx->duration > 0) {
    const double sec = static_cast<double>(fmtCtx->duration) / AV_TIME_BASE;
    if (sec > 0) {
      result.durationMs = static_cast<int64_t>(sec * 1000.0);
      result.isExact = true;
      AUDIO_DECODE_DBG(
          "probe_duration_ok source=format durationMs=%lld exact=%d iformat=%s fd=%d",
          static_cast<long long>(result.durationMs),
          result.isExact ? 1 : 0,
          iformatName,
          inputFd);
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
        AUDIO_DECODE_DBG(
            "probe_duration_ok source=bitrate durationMs=%lld exact=%d iformat=%s fd=%d",
            static_cast<long long>(result.durationMs),
            result.isExact ? 1 : 0,
            iformatName,
            inputFd);
        return result;
      }
    }
  }

  throw std::runtime_error("PROBE_DURATION_UNKNOWN: Could not determine duration");
}

AudioContainerProbeResult probeFileContainerFFmpeg(const char* path, int inputFd) {
  AUDIO_DECODE_DBG(
      "probe_container_start pathHint=%s fd=%d inputKind=%s",
      path ? path : "(null)",
      inputFd,
      inputFd >= 0 ? "content_fd" : "path");

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

  // Sniff container from bytes only — do not open via extension demuxer first
  // (mislabeled .mp3 + Ogg/Opus would otherwise report mp3/mp3).
  constexpr bool kAllowDemuxerAutoProbe = true;
  constexpr bool kTryExtensionDemuxerFirst = false;

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

    const auto openResult = openGuardedFdFormatInput(
        &fmtCtx, path, "PROBE", kAllowDemuxerAutoProbe, kTryExtensionDemuxerFirst);
    if (!openResult.ok) {
      throw std::runtime_error(openResult.errorMessage);
    }
  } else {
    const auto openResult = openGuardedFormatInput(
        &fmtCtx, path, "PROBE", kAllowDemuxerAutoProbe, kTryExtensionDemuxerFirst);
    if (!openResult.ok) {
      throw std::runtime_error(openResult.errorMessage);
    }
  }

  const char* iformatName =
      (fmtCtx->iformat && fmtCtx->iformat->name) ? fmtCtx->iformat->name : "?";
  AUDIO_DECODE_DBG(
      "probe_container_open iformat=%s pathHint=%s fd=%d autoProbeOnly=%d",
      iformatName,
      path ? path : "(null)",
      inputFd,
      1);
  if (ownedFd >= 0) {
    logContainerMagicFromFd(ownedFd, "probe_container_open");
    logDirectFdBytes(ownedFd, 0, 32, "probe_container_file_start");
  }
  logInputIoState(fmtCtx, ownedFd, inputFd, "probe_container_after_open");

  AVDictionary* opts = nullptr;
  av_dict_set(&opts, "analyzeduration", "2000000", 0);
  av_dict_set(&opts, "probesize", "32768", 0);
  if (avformat_find_stream_info(fmtCtx, &opts) < 0) {
    av_dict_free(&opts);
    throw std::runtime_error("PROBE_STREAM_INFO_FAILED: Cannot read stream info");
  }
  av_dict_free(&opts);
  logInputIoState(fmtCtx, ownedFd, inputFd, "probe_container_after_find_stream_info");
  logFormatContextSummary(fmtCtx, -1, "probe_container_after_find_stream_info");

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
  logFormatContextSummary(fmtCtx, audioStreamIdx, "probe_container_stream_selected");

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

  AUDIO_DECODE_DBG(
      "probe_container_ok inputFormat=%s codec=%s iformat=%s fd=%d pathHint=%s",
      result.inputFormatName.c_str(),
      result.codecName.c_str(),
      iformatName,
      inputFd,
      path ? path : "(null)");

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
    AUDIO_DECODE_DBG("Using WAV fast path: rate=%d ch=%d bits=%d", wavInfo.sampleRate, wavInfo.channels, wavInfo.bitsPerSample);
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
  AUDIO_DECODE_DBG("Using FFmpeg decode path: %s targetRate=%d forceMono=%d", pathOrFd ? pathOrFd : "<fd>", config.targetSampleRate, config.forceMono);
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
