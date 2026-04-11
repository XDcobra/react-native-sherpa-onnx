/**
 * SherpaOnnx+PipelineAudio.mm
 *
 * Unified pipeline audio buffer registry for iOS.
 * Mirrors the Kotlin PipelineAudioRegistry with two buffer kinds:
 * - OfflineEntry: immutable PCM (in-memory or file-backed)
 * - LiveEntry: streaming PCM with ring buffer, optional WAV spool, consumer cursors
 *
 * Implements all TurboModule methods for createOfflineAudioBuffer*, createLiveAudioBuffer,
 * appendSamples*, finalize, save, info, release, mic capture.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#include "sherpa-onnx/c-api/cxx-api.h"
#include <mutex>
#include <unordered_map>
#include <vector>
#include <string>
#include <fstream>
#include <functional>
#include <cmath>
#include <atomic>
#include <cstring>

// ==================== Error Codes ====================
static NSString *const kPAErrBufferNotFound   = @"AUDIO_BUFFER_NOT_FOUND";
static NSString *const kPAErrInvalidArgument  = @"AUDIO_INVALID_ARGUMENT";
static NSString *const kPAErrInvalidState     = @"AUDIO_INVALID_STATE";
static NSString *const kPAErrFileNotFound     = @"AUDIO_FILE_NOT_FOUND";
static NSString *const kPAErrFileReadError    = @"AUDIO_FILE_READ_ERROR";
static NSString *const kPAErrFileWriteError   = @"AUDIO_FILE_WRITE_ERROR";
static NSString *const kPAErrAlreadyFinalized = @"AUDIO_ALREADY_FINALIZED";
static NSString *const kPAErrCaptureError     = @"AUDIO_CAPTURE_ERROR";
static NSString *const kPAErrInternalError    = @"AUDIO_INTERNAL_ERROR";

static const char *kPaAppendSourceMic = "mic";
static const char *kPaAppendSourceAppend = "append";
static const char *kPaAppendSourceAppendOffline = "append_offline";
static const char *kPaAppendSourceUnknown = "unknown";
static const char *kPaAppendSourceMixed = "mixed";

// ==================== Resampler ====================
static std::vector<float> pa_resampleLinear(const float *input, size_t inputSize, int inputRate, int outputRate) {
  if (inputSize == 0 || inputRate <= 0 || outputRate <= 0 || inputRate == outputRate) {
    return std::vector<float>(input, input + inputSize);
  }
  size_t outputSize = std::max((size_t)1, (size_t)((int64_t)inputSize * outputRate / inputRate));
  std::vector<float> out(outputSize);
  double ratio = (double)inputRate / (double)outputRate;
  for (size_t i = 0; i < outputSize; i++) {
    double src = i * ratio;
    size_t left = std::min((size_t)src, inputSize > 0 ? inputSize - 1 : 0);
    size_t right = std::min(left + 1, inputSize > 0 ? inputSize - 1 : 0);
    float frac = (float)(src - left);
    out[i] = input[left] + (input[right] - input[left]) * frac;
  }
  return out;
}

static std::vector<int16_t> pa_resampleInt16(const int16_t *input, size_t inputSize, int fromRate, int toRate) {
  if (fromRate == toRate) return std::vector<int16_t>(input, input + inputSize);
  double ratio = (double)fromRate / (double)toRate;
  size_t outLen = (size_t)round((double)inputSize / ratio);
  std::vector<int16_t> result(outLen);
  for (size_t i = 0; i < outLen; i++) {
    double srcIdx = i * ratio;
    size_t idx0 = std::min((size_t)srcIdx, inputSize - 1);
    size_t idx1 = std::min(idx0 + 1, inputSize - 1);
    float frac = (float)(srcIdx - idx0);
    int v = (int)((int)input[idx0] + ((int)input[idx1] - (int)input[idx0]) * frac);
    if (v < -32768) v = -32768;
    if (v > 32767) v = 32767;
    result[i] = (int16_t)v;
  }
  return result;
}

// ==================== WAV Utilities ====================

struct PaWavHeader {
  int sampleRate = 0;
  int channelCount = 0;
  int bitsPerSample = 0;
  int audioFormat = 0; // 1=PCM, 3=float
  long dataOffset = 0;
  long dataSize = 0;
  int numSamples = 0;
};

static bool pa_parseWavHeader(const std::string &filePath, PaWavHeader &hdr) {
  std::ifstream f(filePath, std::ios::binary);
  if (!f) return false;

  char buf[4];
  auto readU32LE = [&]() -> uint32_t {
    uint32_t v = 0;
    f.read(reinterpret_cast<char*>(&v), 4);
    return v;
  };
  auto readU16LE = [&]() -> uint16_t {
    uint16_t v = 0;
    f.read(reinterpret_cast<char*>(&v), 2);
    return v;
  };

  f.read(buf, 4); if (std::string(buf, 4) != "RIFF") return false;
  readU32LE(); // file size
  f.read(buf, 4); if (std::string(buf, 4) != "WAVE") return false;

  while (f) {
    f.read(buf, 4); if (!f) break;
    std::string chunkId(buf, 4);
    uint32_t chunkSize = readU32LE();
    long chunkStart = f.tellg();

    if (chunkId == "fmt ") {
      if (chunkSize < 16) { f.seekg(chunkStart + chunkSize); continue; }
      hdr.audioFormat = readU16LE();
      hdr.channelCount = readU16LE();
      hdr.sampleRate = readU32LE();
      readU32LE(); // byteRate
      readU16LE(); // blockAlign
      hdr.bitsPerSample = readU16LE();
      f.seekg(chunkStart + chunkSize);
    } else if (chunkId == "data") {
      hdr.dataOffset = f.tellg();
      hdr.dataSize = chunkSize;
      break;
    } else {
      f.seekg(chunkStart + chunkSize);
    }
  }

  if (hdr.dataSize <= 0 || hdr.sampleRate <= 0) return false;
  bool supported = (hdr.audioFormat == 1 && hdr.bitsPerSample == 16 && hdr.channelCount == 1) ||
                   (hdr.audioFormat == 3 && hdr.bitsPerSample == 32 && hdr.channelCount == 1);
  if (!supported) return false;
  hdr.numSamples = (int)(hdr.dataSize / (hdr.bitsPerSample / 8));
  return true;
}

static void pa_writeWavHeaderToStream(std::ofstream &f, int sampleRate, int bitsPerSample, int audioFormat, int dataSize) {
  auto writeU32LE = [&](uint32_t v) { f.write(reinterpret_cast<char*>(&v), 4); };
  auto writeU16LE = [&](uint16_t v) { f.write(reinterpret_cast<char*>(&v), 2); };
  int fileSize = 44 + dataSize;
  f.write("RIFF", 4);
  writeU32LE(fileSize - 8);
  f.write("WAVE", 4);
  f.write("fmt ", 4);
  writeU32LE(16);
  writeU16LE(audioFormat);
  writeU16LE(1); // mono
  writeU32LE(sampleRate);
  int bytesPerSample = bitsPerSample / 8;
  writeU32LE(sampleRate * bytesPerSample);
  writeU16LE(bytesPerSample);
  writeU16LE(bitsPerSample);
  f.write("data", 4);
  writeU32LE(dataSize);
}

static void pa_writeFloat32AsInt16Wav(const float *samples, int numSamples, int sampleRate, const std::string &path) {
  std::ofstream f(path, std::ios::binary | std::ios::trunc);
  int dataSize = numSamples * 2;
  pa_writeWavHeaderToStream(f, sampleRate, 16, 1, dataSize);
  for (int i = 0; i < numSamples; i++) {
    float c = std::max(-1.0f, std::min(1.0f, samples[i]));
    int16_t s = (int16_t)std::max(-32768, std::min(32767, (int)(c * 32767.0f)));
    f.write(reinterpret_cast<char*>(&s), 2);
  }
}

// ==================== Offline Entry ====================

struct PaOfflineEntry {
  std::string bufferId;
  int sampleRate;
  int channelCount;
  // In-memory variant
  std::vector<float> samples;
  // File-backed variant
  bool isFileBacked = false;
  std::string filePath;
  PaWavHeader wavHeader;

  int numSamples() const {
    return isFileBacked ? wavHeader.numSamples : (int)samples.size();
  }
  double durationMs() const {
    return sampleRate > 0 ? (double)numSamples() / sampleRate * 1000.0 : 0.0;
  }

  NSDictionary *toDict() const {
    return @{
      @"bufferId": [NSString stringWithUTF8String:bufferId.c_str()],
      @"kind": @"offlinePcmBuffer",
      @"state": @"immutable",
      @"sampleRate": @(sampleRate),
      @"channelCount": @(channelCount),
      @"numSamples": @(numSamples()),
      @"durationMs": @(durationMs())
    };
  }

  std::vector<float> readAllSamples() const {
    if (!isFileBacked) return samples;
    std::vector<float> result(wavHeader.numSamples);
    std::ifstream f(filePath, std::ios::binary);
    f.seekg(wavHeader.dataOffset);
    if (wavHeader.audioFormat == 1 && wavHeader.bitsPerSample == 16) {
      std::vector<int16_t> buf(wavHeader.numSamples);
      f.read(reinterpret_cast<char*>(buf.data()), wavHeader.numSamples * 2);
      for (int i = 0; i < wavHeader.numSamples; i++) {
        result[i] = (float)buf[i] / 32768.0f;
      }
    } else if (wavHeader.audioFormat == 3 && wavHeader.bitsPerSample == 32) {
      f.read(reinterpret_cast<char*>(result.data()), wavHeader.numSamples * 4);
    }
    return result;
  }

  void saveToWav(const std::string &outputPath) const {
    if (!isFileBacked) {
      pa_writeFloat32AsInt16Wav(samples.data(), (int)samples.size(), sampleRate, outputPath);
    } else {
      // Stream-copy from file-backed source
      auto allSamples = readAllSamples();
      pa_writeFloat32AsInt16Wav(allSamples.data(), (int)allSamples.size(), sampleRate, outputPath);
    }
  }
};

// ==================== Live Entry ====================

struct PaLiveEntry {
  enum State { RECORDING, FINISHED };

  std::string bufferId;
  int sampleRate;
  int channelCount;
  State state = RECORDING;

  // Ring buffer
  int windowCapacity;
  std::vector<float> ring;
  int writePos = 0;
  int64_t totalSamplesWritten = 0;
  int64_t totalSamplesDropped = 0;
  std::mutex ringMutex;

  // Spool
  bool hasActiveSpool = false;
  std::string spoolPath;
  bool spoolIsFloat = false;
  std::ofstream spoolFile;
  int64_t spoolSamplesWritten = 0;

  // Cursors
  struct CursorHandle {
    int cursorId;
    int64_t absoluteReadPos;
  };
  int nextCursorId = 0;
  std::unordered_map<int, CursorHandle> cursors;

  // Append events
  bool appendEventsEnabled = false;
  bool appendEventsIncludeSamples = true;
  int appendEventMinIntervalMs = 0;
  std::function<void(const std::string &, const std::vector<float> &, int, int64_t)> onFramesAppended;
  std::mutex appendEventMutex;
  uint64_t lastAppendEventAtMs = 0;
  int pendingFrames = 0;
  std::vector<float> pendingSamples;
  std::string pendingSource;

  PaLiveEntry(const std::string &bid, int sr, int ch, double windowSec,
              const std::string &spoolPathArg, bool spoolFloat,
              bool emitAppendedEvents,
              bool emitAppendedSamples,
              int appendEventMinIntervalMsArg,
              std::function<void(const std::string &, const std::vector<float> &, int, int64_t)> onFramesAppendedArg)
    : bufferId(bid), sampleRate(sr), channelCount(ch) {
    appendEventsEnabled = emitAppendedEvents;
    appendEventsIncludeSamples = emitAppendedSamples;
    appendEventMinIntervalMs = std::max(0, appendEventMinIntervalMsArg);
    onFramesAppended = std::move(onFramesAppendedArg);

    windowCapacity = std::max(sr, (int)(windowSec * sr));
    ring.resize(windowCapacity, 0.0f);

    if (!spoolPathArg.empty()) {
      hasActiveSpool = true;
      spoolPath = spoolPathArg;
      spoolIsFloat = spoolFloat;
      spoolFile.open(spoolPath, std::ios::binary | std::ios::trunc);
      if (spoolFile) {
        // Write placeholder header
        int bytesPerSample = spoolFloat ? 4 : 2;
        int audioFormat = spoolFloat ? 3 : 1;
        pa_writeWavHeaderToStream(spoolFile, sr, bytesPerSample * 8, audioFormat, 0);
      }
    }
  }

  int64_t numSamples() const {
    if (state == FINISHED) return totalSamplesWritten;
    return std::min(totalSamplesWritten, (int64_t)windowCapacity);
  }

  double durationMs() const {
    return sampleRate > 0 ? (double)numSamples() / sampleRate * 1000.0 : 0.0;
  }

  NSDictionary *toDict() {
    return @{
      @"bufferId": [NSString stringWithUTF8String:bufferId.c_str()],
      @"kind": @"livePcmBuffer",
      @"state": (state == RECORDING) ? @"recording" : @"finished",
      @"sampleRate": @(sampleRate),
      @"channelCount": @(channelCount),
      @"numSamples": @((double)numSamples()),
      @"durationMs": @(durationMs()),
      @"totalSamplesWritten": @((double)totalSamplesWritten),
      @"totalSamplesDropped": @((double)totalSamplesDropped),
      @"hasActiveSpool": @(hasActiveSpool)
    };
  }

  void appendSamples(const float *data, size_t count, int inputRate, const std::string &source = kPaAppendSourceUnknown) {
    std::vector<float> resampled;
    const float *toAppend = data;
    size_t appendCount = count;
    if (inputRate != sampleRate) {
      resampled = pa_resampleLinear(data, count, inputRate, sampleRate);
      toAppend = resampled.data();
      appendCount = resampled.size();
    }

    {
      std::lock_guard<std::mutex> lock(ringMutex);
      for (size_t i = 0; i < appendCount; i++) {
        ring[writePos] = toAppend[i];
        writePos = (writePos + 1) % windowCapacity;
      }
      int64_t prevTotal = totalSamplesWritten;
      totalSamplesWritten = prevTotal + (int64_t)appendCount;
      if (prevTotal >= windowCapacity) {
        totalSamplesDropped += (int64_t)appendCount;
      } else {
        int64_t overflow = (prevTotal + (int64_t)appendCount) - windowCapacity;
        if (overflow > 0) totalSamplesDropped += overflow;
      }
    }

    // Write to spool (outside ring lock)
    if (hasActiveSpool && spoolFile.is_open()) {
      if (spoolIsFloat) {
        spoolFile.write(reinterpret_cast<const char*>(toAppend), appendCount * 4);
      } else {
        for (size_t i = 0; i < appendCount; i++) {
          float c = std::max(-1.0f, std::min(1.0f, toAppend[i]));
          int16_t s = (int16_t)std::max(-32768, std::min(32767, (int)(c * 32767.0f)));
          spoolFile.write(reinterpret_cast<char*>(&s), 2);
        }
      }
      spoolSamplesWritten += appendCount;
    }

    dispatchFramesAppended(toAppend, appendCount, source);
  }

  void configureAppendEvents(bool enabled, bool includeSamples, int minIntervalMs) {
    std::lock_guard<std::mutex> lock(appendEventMutex);
    appendEventsEnabled = enabled;
    appendEventsIncludeSamples = includeSamples;
    appendEventMinIntervalMs = std::max(0, minIntervalMs);
    if (!appendEventsEnabled) {
      pendingFrames = 0;
      pendingSamples.clear();
      pendingSource.clear();
    }
    if (!appendEventsIncludeSamples) {
      pendingSamples.clear();
    }
  }

  void dispatchFramesAppended(const float *appendedSamples, size_t appendedCount, const std::string &source) {
    if (!appendEventsEnabled || !onFramesAppended) return;

    std::vector<float> samplesToEmit;
    std::string sourceToEmit;
    int frameCountToEmit = 0;
    int64_t totalWrittenToEmit = 0;
    bool shouldEmit = false;

    {
      std::lock_guard<std::mutex> lock(appendEventMutex);
      pendingFrames += (int)appendedCount;
      if (pendingSource.empty()) {
        pendingSource = source;
      } else if (pendingSource != source) {
        pendingSource = kPaAppendSourceMixed;
      }

      if (appendEventsIncludeSamples && appendedSamples != nullptr && appendedCount > 0) {
        pendingSamples.insert(pendingSamples.end(), appendedSamples, appendedSamples + appendedCount);
      }

      uint64_t nowMs = (uint64_t)(CFAbsoluteTimeGetCurrent() * 1000.0);
      bool intervalReached = appendEventMinIntervalMs <= 0 ||
                             lastAppendEventAtMs == 0 ||
                             (nowMs - lastAppendEventAtMs) >= (uint64_t)appendEventMinIntervalMs;

      if (intervalReached && pendingFrames > 0) {
        frameCountToEmit = pendingFrames;
        sourceToEmit = pendingSource.empty() ? kPaAppendSourceUnknown : pendingSource;
        totalWrittenToEmit = totalSamplesWritten;
        if (appendEventsIncludeSamples) {
          samplesToEmit.swap(pendingSamples);
        }
        pendingFrames = 0;
        pendingSource.clear();
        lastAppendEventAtMs = nowMs;
        shouldEmit = true;
      }
    }

    if (shouldEmit && onFramesAppended) {
      onFramesAppended(sourceToEmit, samplesToEmit, frameCountToEmit, totalWrittenToEmit);
    }
  }

  void flushPendingFramesAppended() {
    if (!appendEventsEnabled || !onFramesAppended) return;

    std::vector<float> samplesToEmit;
    std::string sourceToEmit;
    int frameCountToEmit = 0;
    int64_t totalWrittenToEmit = 0;

    {
      std::lock_guard<std::mutex> lock(appendEventMutex);
      if (pendingFrames <= 0) return;

      frameCountToEmit = pendingFrames;
      sourceToEmit = pendingSource.empty() ? kPaAppendSourceUnknown : pendingSource;
      totalWrittenToEmit = totalSamplesWritten;
      if (appendEventsIncludeSamples) {
        samplesToEmit.swap(pendingSamples);
      }

      pendingFrames = 0;
      pendingSource.clear();
      lastAppendEventAtMs = (uint64_t)(CFAbsoluteTimeGetCurrent() * 1000.0);
    }

    onFramesAppended(sourceToEmit, samplesToEmit, frameCountToEmit, totalWrittenToEmit);
  }

  void finalize_() {
    if (state == FINISHED) return;
    state = FINISHED;

    if (hasActiveSpool && spoolFile.is_open()) {
      spoolFile.flush();
      int bytesPerSample = spoolIsFloat ? 4 : 2;
      int64_t dataSize = spoolSamplesWritten * bytesPerSample;

      // Patch RIFF size at offset 4
      spoolFile.seekp(4, std::ios::beg);
      uint32_t riffSize = (uint32_t)(44 + dataSize - 8);
      spoolFile.write(reinterpret_cast<char*>(&riffSize), 4);

      // Patch data size at offset 40
      spoolFile.seekp(40, std::ios::beg);
      uint32_t dataSz = (uint32_t)dataSize;
      spoolFile.write(reinterpret_cast<char*>(&dataSz), 4);

      spoolFile.close();
    }

    flushPendingFramesAppended();
  }

  std::vector<float> snapshotRing() {
    std::lock_guard<std::mutex> lock(ringMutex);
    int used = (int)std::min(totalSamplesWritten, (int64_t)windowCapacity);
    if (used == 0) return {};
    std::vector<float> out(used);
    if (totalSamplesWritten <= windowCapacity) {
      std::copy(ring.begin(), ring.begin() + used, out.begin());
    } else {
      int firstPart = windowCapacity - writePos;
      std::copy(ring.begin() + writePos, ring.begin() + writePos + firstPart, out.begin());
      std::copy(ring.begin(), ring.begin() + writePos, out.begin() + firstPart);
    }
    return out;
  }

  std::vector<float> getSamplesSlice(int startFrame, int frameCount) {
    std::lock_guard<std::mutex> lock(ringMutex);
    int used = (int)std::min(totalSamplesWritten, (int64_t)windowCapacity);
    if (startFrame >= used || frameCount <= 0) return {};
    int actualCount = std::min(frameCount, used - startFrame);
    std::vector<float> out(actualCount);
    int ringStart = (totalSamplesWritten <= windowCapacity) ? startFrame : (writePos + startFrame) % windowCapacity;
    for (int i = 0; i < actualCount; i++) {
      out[i] = ring[(ringStart + i) % windowCapacity];
    }
    return out;
  }

  int createCursorHandle() {
    int id = nextCursorId++;
    int64_t startPos = (totalSamplesWritten > windowCapacity) ? totalSamplesWritten - windowCapacity : 0;
    cursors[id] = { id, startPos };
    return id;
  }

  std::vector<float> drainCursor(int cursorId, int maxSamples) {
    auto it = cursors.find(cursorId);
    if (it == cursors.end()) return {};

    std::lock_guard<std::mutex> lock(ringMutex);
    int64_t oldestAvailable = (totalSamplesWritten > windowCapacity) ? totalSamplesWritten - windowCapacity : 0;
    int64_t readPos = std::max(it->second.absoluteReadPos, oldestAvailable);
    int available = (int)std::max((int64_t)0, totalSamplesWritten - readPos);
    if (available == 0) return {};
    int count = std::min(maxSamples, available);
    std::vector<float> out(count);
    int ringOffset = (int)(readPos % windowCapacity);
    for (int i = 0; i < count; i++) {
      out[i] = ring[(ringOffset + i) % windowCapacity];
    }
    it->second.absoluteReadPos = readPos + count;
    return out;
  }

  void saveToWav(const std::string &outputPath) {
    if (hasActiveSpool && state == FINISHED && !spoolPath.empty()) {
      // Copy spool file
      std::ifstream src(spoolPath, std::ios::binary);
      std::ofstream dst(outputPath, std::ios::binary | std::ios::trunc);
      dst << src.rdbuf();
    } else {
      auto snapshot = snapshotRing();
      pa_writeFloat32AsInt16Wav(snapshot.data(), (int)snapshot.size(), sampleRate, outputPath);
    }
  }

  void release() {
    if (state == RECORDING) finalize_();
    flushPendingFramesAppended();
    if (spoolFile.is_open()) spoolFile.close();
    cursors.clear();
  }
};

// ==================== Registry ====================

// Non-static: shared with SherpaOnnx+STT.mm via SherpaOnnx+PipelineAudioGlobals.h
std::unordered_map<std::string, std::shared_ptr<PaOfflineEntry>> g_pa_offline;
std::unordered_map<std::string, std::shared_ptr<PaLiveEntry>> g_pa_live;
std::mutex g_pa_mutex;
static const long kPaFileBackedThreshold = 10L * 1024 * 1024; // 10 MB

static std::string pa_generateId(const char *prefix) {
  return std::string(prefix) + "_" + [[[NSUUID UUID] UUIDString] UTF8String];
}

// ==================== Mic Capture ====================

static const int kPaMicCaptureRates[] = { 16000, 44100, 48000 };
static const size_t kPaMicCaptureRatesCount = 3;
static const UInt32 kPaMicAQNumberBuffers = 3;

static std::shared_ptr<PaLiveEntry> _paMicLiveEntry = nullptr;
static AudioQueueRef _paMicAudioQueue = NULL;
static AudioQueueBufferRef _paMicAQBuffers[kPaMicAQNumberBuffers];
static volatile BOOL _paMicAQRunning = NO;
static NSInteger _paMicCaptureRate = 16000;

static void paMicStopQueue(void) {
  if (_paMicAudioQueue == NULL) return;
  _paMicAQRunning = NO;
  AudioQueueStop(_paMicAudioQueue, true);
  for (UInt32 i = 0; i < kPaMicAQNumberBuffers; i++) {
    if (_paMicAQBuffers[i] != NULL) {
      AudioQueueFreeBuffer(_paMicAudioQueue, _paMicAQBuffers[i]);
      _paMicAQBuffers[i] = NULL;
    }
  }
  AudioQueueDispose(_paMicAudioQueue, true);
  _paMicAudioQueue = NULL;
  if (_paMicLiveEntry) {
    _paMicLiveEntry->flushPendingFramesAppended();
  }
  _paMicLiveEntry = nullptr;
}

static void paMicAQInputCallback(void *inUserData,
                                  AudioQueueRef inAQ,
                                  AudioQueueBufferRef inBuffer,
                                  const AudioTimeStamp *inStartTime,
                                  UInt32 inNumPackets,
                                  const AudioStreamPacketDescription *inPacketDesc) {
  (void)inUserData; (void)inStartTime; (void)inNumPackets; (void)inPacketDesc;
  if (!_paMicAQRunning) return;
  auto liveEntry = _paMicLiveEntry;
  if (!liveEntry || liveEntry->state != PaLiveEntry::RECORDING) return;

  UInt32 byteSize = inBuffer->mAudioDataByteSize;
  if (byteSize == 0) {
    AudioQueueEnqueueBuffer(inAQ, inBuffer, 0, NULL);
    return;
  }

  const int16_t *rawSamples = (const int16_t *)inBuffer->mAudioData;
  NSUInteger rawCount = byteSize / sizeof(int16_t);
  int targetRate = liveEntry->sampleRate;

  // Resample if needed
  std::vector<int16_t> resampledBuf;
  const int16_t *samples16 = rawSamples;
  size_t count16 = rawCount;
  if ((int)_paMicCaptureRate != targetRate) {
    resampledBuf = pa_resampleInt16(rawSamples, rawCount, (int)_paMicCaptureRate, targetRate);
    samples16 = resampledBuf.data();
    count16 = resampledBuf.size();
  }

  // Convert to float and write to live entry
  std::vector<float> floatSamples(count16);
  for (size_t i = 0; i < count16; i++) {
    floatSamples[i] = (float)samples16[i] / 32768.0f;
  }
  liveEntry->appendSamples(floatSamples.data(), floatSamples.size(), targetRate, kPaAppendSourceMic);

  AudioQueueEnqueueBuffer(inAQ, inBuffer, 0, NULL);
}

// ==================== Category Implementation ====================

@implementation SherpaOnnx (PipelineAudio)

// ---- Offline: from file ----
#if __has_include(<SherpaOnnxSpec/SherpaOnnxSpec.h>)
- (void)createOfflineAudioBufferFromFile:(NSString *)sourcePath
                      targetSampleRateHz:(NSNumber *)targetSampleRateHz
                               forceMono:(NSNumber *)forceMono
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string path = [sourcePath UTF8String];
    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm fileExistsAtPath:sourcePath]) {
      reject(kPAErrFileNotFound, @"Audio file does not exist", nil);
      return;
    }
    NSDictionary *attrs = [fm attributesOfItemAtPath:sourcePath error:nil];
    long long fileSize = [attrs[NSFileSize] longLongValue];
    if (fileSize == 0) {
      reject(kPAErrInvalidArgument, @"Audio file is empty", nil);
      return;
    }

    std::string bufferId = pa_generateId("off");
    auto entry = std::make_shared<PaOfflineEntry>();
    entry->bufferId = bufferId;
    entry->channelCount = 1;

    int targetRate = targetSampleRateHz ? [targetSampleRateHz intValue] : 0;
    if (targetRate < 0) { reject(kPAErrInvalidArgument, @"targetSampleRateHz must be > 0", nil); return; }

    // For large files without resampling, try file-backed
    if (fileSize > kPaFileBackedThreshold && targetRate == 0) {
      PaWavHeader hdr;
      if (pa_parseWavHeader(path, hdr)) {
        entry->isFileBacked = true;
        entry->filePath = path;
        entry->sampleRate = hdr.sampleRate;
        entry->channelCount = hdr.channelCount;
        entry->wavHeader = hdr;
        {
          std::lock_guard<std::mutex> lock(g_pa_mutex);
          g_pa_offline[bufferId] = entry;
        }
        resolve(entry->toDict());
        return;
      }
    }

    // In-memory via sherpa-onnx ReadWave
    auto wave = sherpa_onnx::cxx::ReadWave(path);
    if (wave.samples.empty()) {
      reject(kPAErrFileReadError, @"Could not read audio samples", nil);
      return;
    }

    int outputRate = targetRate > 0 ? targetRate : wave.sample_rate;
    if (outputRate != wave.sample_rate) {
      entry->samples = pa_resampleLinear(wave.samples.data(), wave.samples.size(), wave.sample_rate, outputRate);
    } else {
      entry->samples = std::move(wave.samples);
    }
    entry->sampleRate = outputRate;

    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      g_pa_offline[bufferId] = entry;
    }
    resolve(entry->toDict());
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Offline: from samples ----
- (void)createOfflineAudioBufferFromSamples:(NSArray<NSNumber *> *)samples
                                 sampleRate:(double)sampleRate
                               channelCount:(NSNumber *)channelCount
                                    resolve:(RCTPromiseResolveBlock)resolve
                                     reject:(RCTPromiseRejectBlock)reject
{
  @try {
    if (sampleRate <= 0) { reject(kPAErrInvalidArgument, @"sampleRate must be > 0", nil); return; }
    if (samples.count == 0) { reject(kPAErrInvalidArgument, @"samples must not be empty", nil); return; }

    std::string bufferId = pa_generateId("off");
    auto entry = std::make_shared<PaOfflineEntry>();
    entry->bufferId = bufferId;
    entry->sampleRate = (int)sampleRate;
    entry->channelCount = channelCount ? [channelCount intValue] : 1;
    entry->samples.resize(samples.count);
    for (NSUInteger i = 0; i < samples.count; i++) {
      entry->samples[i] = [samples[i] floatValue];
    }
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      g_pa_offline[bufferId] = entry;
    }
    resolve(entry->toDict());
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Offline: empty (output target for TTS) ----
- (void)createEmptyOfflineAudioBuffer:(double)sampleRate
                         channelCount:(NSNumber *)channelCount
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  @try {
    if (sampleRate <= 0) { reject(kPAErrInvalidArgument, @"sampleRate must be > 0", nil); return; }
    int ch = channelCount ? [channelCount intValue] : 1;
    if (ch != 1) { reject(kPAErrInvalidArgument, @"Only mono (channelCount=1) is supported", nil); return; }

    std::string bufferId = pa_generateId("off");
    auto entry = std::make_shared<PaOfflineEntry>();
    entry->bufferId = bufferId;
    entry->sampleRate = (int)sampleRate;
    entry->channelCount = ch;
    // samples is empty — will be populated by TTS synthesis
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      g_pa_offline[bufferId] = entry;
    }
    resolve(entry->toDict());
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Offline: from live ----
- (void)createOfflineAudioBufferFromLive:(NSString *)liveBufferId
                                    mode:(NSString *)mode
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string liveId = [liveBufferId UTF8String];
    std::shared_ptr<PaLiveEntry> live;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_live.find(liveId);
      if (it == g_pa_live.end()) {
        reject(kPAErrBufferNotFound, @"Live buffer not found", nil);
        return;
      }
      live = it->second;
    }

    std::string modeStr = mode ? [mode UTF8String] : "fullIfSpooled";
    std::string bufferId = pa_generateId("off");
    auto entry = std::make_shared<PaOfflineEntry>();
    entry->bufferId = bufferId;
    entry->sampleRate = live->sampleRate;
    entry->channelCount = live->channelCount;

    if (modeStr == "fullIfSpooled" && live->hasActiveSpool && live->state == PaLiveEntry::FINISHED && !live->spoolPath.empty()) {
      PaWavHeader hdr;
      if (pa_parseWavHeader(live->spoolPath, hdr)) {
        entry->isFileBacked = true;
        entry->filePath = live->spoolPath;
        entry->wavHeader = hdr;
      } else {
        entry->samples = live->snapshotRing();
      }
    } else {
      entry->samples = live->snapshotRing();
    }

    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      g_pa_offline[bufferId] = entry;
    }
    resolve(entry->toDict());
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Live: create ----
- (void)createLiveAudioBuffer:(JS::NativeSherpaOnnx::SpecCreateLiveAudioBufferOptions &)options
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  @try {
    int sr = (int)options.sampleRate();
    if (sr <= 0) { reject(kPAErrInvalidArgument, @"sampleRate must be > 0", nil); return; }
    int ch = options.channelCount().has_value() ? (int)options.channelCount().value() : 1;
    double windowSec = options.windowSeconds().has_value() ? options.windowSeconds().value() : 60.0;
    if (windowSec <= 0) { reject(kPAErrInvalidArgument, @"windowSeconds must be > 0", nil); return; }

    std::string spoolPath;
    bool spoolFloat = false;
    if (options.persistencePath()) {
      spoolPath = [options.persistencePath() UTF8String];
      if (options.persistenceFormat()) {
        NSString *fmt = options.persistenceFormat();
        spoolFloat = [fmt isEqualToString:@"wav_pcm_float"];
      }
    }

    bool emitAppendedEvents = options.emitAppendedEvents().has_value() ? options.emitAppendedEvents().value() : false;
    bool emitAppendedSamples = options.emitAppendedSamples().has_value() ? options.emitAppendedSamples().value() : true;
    int appendEventMinIntervalMs = options.appendEventMinIntervalMs().has_value()
      ? std::max(0, (int)options.appendEventMinIntervalMs().value())
      : 0;

    std::string bufferId = pa_generateId("live");
    NSString *liveBufferId = [NSString stringWithUTF8String:bufferId.c_str()];
    __weak SherpaOnnx *weakSelf = self;

    auto onFramesAppended = [weakSelf, liveBufferId, sr](
      const std::string &source,
      const std::vector<float> &samples,
      int frameCount,
      int64_t totalSamplesWritten
    ) {
      SherpaOnnx *module = weakSelf;
      if (!module) return;

      NSMutableDictionary *payload = [NSMutableDictionary dictionary];
      payload[@"liveBufferId"] = liveBufferId ?: @"";
      payload[@"source"] = [NSString stringWithUTF8String:source.c_str()];
      payload[@"sampleRate"] = @(sr);
      payload[@"frameCount"] = @(frameCount);
      payload[@"totalSamplesWritten"] = @((double)totalSamplesWritten);

      if (!samples.empty()) {
        NSMutableArray *arr = [NSMutableArray arrayWithCapacity:samples.size()];
        for (float s : samples) {
          [arr addObject:@(s)];
        }
        payload[@"samples"] = arr;
      }

      dispatch_async(dispatch_get_main_queue(), ^{
        [module sendEventWithName:@"pipelineLiveAudioChunk" body:payload];
      });
    };

    auto entry = std::make_shared<PaLiveEntry>(
      bufferId,
      sr,
      ch,
      windowSec,
      spoolPath,
      spoolFloat,
      emitAppendedEvents,
      emitAppendedSamples,
      appendEventMinIntervalMs,
      onFramesAppended
    );
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      g_pa_live[bufferId] = entry;
    }
    resolve(entry->toDict());
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Live: append samples ----
- (void)appendSamplesToLiveAudioBuffer:(NSString *)liveBufferId
                               samples:(NSArray<NSNumber *> *)samples
                            sampleRate:(double)sampleRate
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string liveId = [liveBufferId UTF8String];
    std::shared_ptr<PaLiveEntry> live;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_live.find(liveId);
      if (it == g_pa_live.end()) {
        reject(kPAErrBufferNotFound, @"Live buffer not found", nil);
        return;
      }
      live = it->second;
    }
    if (live->state != PaLiveEntry::RECORDING) {
      reject(kPAErrAlreadyFinalized, @"Live buffer is finalized", nil);
      return;
    }
    std::vector<float> floats(samples.count);
    for (NSUInteger i = 0; i < samples.count; i++) {
      floats[i] = [samples[i] floatValue];
    }
    live->appendSamples(floats.data(), floats.size(), (int)sampleRate, kPaAppendSourceAppend);
    resolve(nil);
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Live: append offline ----
- (void)appendOfflineToLiveAudioBuffer:(NSString *)liveBufferId
                       offlineBufferId:(NSString *)offlineBufferId
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string liveId = [liveBufferId UTF8String];
    std::string offId = [offlineBufferId UTF8String];
    std::shared_ptr<PaLiveEntry> live;
    std::shared_ptr<PaOfflineEntry> offline;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto lit = g_pa_live.find(liveId);
      if (lit == g_pa_live.end()) { reject(kPAErrBufferNotFound, @"Live buffer not found", nil); return; }
      live = lit->second;
      auto oit = g_pa_offline.find(offId);
      if (oit == g_pa_offline.end()) { reject(kPAErrBufferNotFound, @"Offline buffer not found", nil); return; }
      offline = oit->second;
    }
    if (live->state != PaLiveEntry::RECORDING) {
      reject(kPAErrAlreadyFinalized, @"Live buffer is finalized", nil);
      return;
    }
    auto allSamples = offline->readAllSamples();
    live->appendSamples(allSamples.data(), allSamples.size(), offline->sampleRate, kPaAppendSourceAppendOffline);
    resolve(nil);
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Live: finalize ----
- (void)finalizeLiveAudioBuffer:(NSString *)liveBufferId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string liveId = [liveBufferId UTF8String];
    std::shared_ptr<PaLiveEntry> live;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_live.find(liveId);
      if (it == g_pa_live.end()) { reject(kPAErrBufferNotFound, @"Live buffer not found", nil); return; }
      live = it->second;
    }
    live->finalize_();
    resolve(nil);
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Save: offline ----
- (void)saveOfflineAudioBufferToWav:(NSString *)bufferId
                         outputPath:(NSString *)outputPath
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string bid = [bufferId UTF8String];
    std::shared_ptr<PaOfflineEntry> entry;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_offline.find(bid);
      if (it == g_pa_offline.end()) { reject(kPAErrBufferNotFound, @"Offline buffer not found", nil); return; }
      entry = it->second;
    }
    entry->saveToWav([outputPath UTF8String]);
    resolve(nil);
  } @catch (NSException *e) {
    reject(kPAErrFileWriteError, e.reason, nil);
  }
}

// ---- Save: live ----
- (void)saveLiveAudioBufferToWav:(NSString *)liveBufferId
                      outputPath:(NSString *)outputPath
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string liveId = [liveBufferId UTF8String];
    std::shared_ptr<PaLiveEntry> live;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_live.find(liveId);
      if (it == g_pa_live.end()) { reject(kPAErrBufferNotFound, @"Live buffer not found", nil); return; }
      live = it->second;
    }
    live->saveToWav([outputPath UTF8String]);
    resolve(nil);
  } @catch (NSException *e) {
    reject(kPAErrFileWriteError, e.reason, nil);
  }
}

// ---- Info ----
- (void)getPipelineAudioBufferInfo:(NSString *)bufferId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  std::string bid = [bufferId UTF8String];
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  auto offIt = g_pa_offline.find(bid);
  if (offIt != g_pa_offline.end()) {
    resolve(offIt->second->toDict());
    return;
  }
  auto liveIt = g_pa_live.find(bid);
  if (liveIt != g_pa_live.end()) {
    resolve(liveIt->second->toDict());
    return;
  }
  reject(kPAErrBufferNotFound, @"Buffer not found", nil);
}

// ---- Release ----
- (void)releasePipelineAudioBuffer:(NSString *)bufferId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  std::string bid = [bufferId UTF8String];
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  auto offIt = g_pa_offline.find(bid);
  if (offIt != g_pa_offline.end()) {
    g_pa_offline.erase(offIt);
    resolve(nil);
    return;
  }
  auto liveIt = g_pa_live.find(bid);
  if (liveIt != g_pa_live.end()) {
    liveIt->second->release();
    g_pa_live.erase(liveIt);
    resolve(nil);
    return;
  }
  resolve(nil); // idempotent
}

// ---- Live: samples slice ----
- (void)getLiveAudioBufferSamplesSlice:(NSString *)liveBufferId
                            startFrame:(double)startFrame
                            frameCount:(double)frameCount
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string liveId = [liveBufferId UTF8String];
    std::shared_ptr<PaLiveEntry> live;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_live.find(liveId);
      if (it == g_pa_live.end()) { reject(kPAErrBufferNotFound, @"Live buffer not found", nil); return; }
      live = it->second;
    }
    auto samples = live->getSamplesSlice((int)startFrame, (int)frameCount);
    NSMutableArray *arr = [NSMutableArray arrayWithCapacity:samples.size()];
    for (float s : samples) {
      [arr addObject:@(s)];
    }
    resolve(arr);
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Mic: start ----
- (void)startMicToLiveAudioBuffer:(NSString *)liveBufferId
                          options:(NSDictionary *)options
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  @try {
    paMicStopQueue();

    std::string liveId = [liveBufferId UTF8String];
    std::shared_ptr<PaLiveEntry> live;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_live.find(liveId);
      if (it == g_pa_live.end()) { reject(kPAErrBufferNotFound, @"Live buffer not found", nil); return; }
      live = it->second;
    }
    if (live->state != PaLiveEntry::RECORDING) {
      reject(kPAErrInvalidState, @"Live buffer is finalized", nil);
      return;
    }

    _paMicLiveEntry = live;

    // Compatibility option: emitToJs now toggles centralized append-event emission.
    if (options[@"emitToJs"] != nil) {
      bool emitToJs = [options[@"emitToJs"] boolValue];
      live->configureAppendEvents(emitToJs, emitToJs, live->appendEventMinIntervalMs);
    }

    // Audio session
    NSError *error = nil;
    AVAudioSession *session = [AVAudioSession sharedInstance];
    if (![session setCategory:AVAudioSessionCategoryPlayAndRecord
                         mode:AVAudioSessionModeDefault
                      options:AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionAllowBluetooth
                        error:&error]) {
      reject(kPAErrCaptureError, error.localizedDescription, error);
      return;
    }
    if (![session setActive:YES withOptions:0 error:&error]) {
      reject(kPAErrCaptureError, error.localizedDescription, error);
      return;
    }

    AudioStreamBasicDescription fmt;
    memset(&fmt, 0, sizeof(fmt));
    fmt.mFormatID = kAudioFormatLinearPCM;
    fmt.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
    fmt.mChannelsPerFrame = 1;
    fmt.mBitsPerChannel = 16;
    fmt.mBytesPerPacket = 2;
    fmt.mBytesPerFrame = 2;
    fmt.mFramesPerPacket = 1;

    OSStatus status = noErr;
    int chosenRate = 16000;
    for (size_t r = 0; r < kPaMicCaptureRatesCount; r++) {
      chosenRate = kPaMicCaptureRates[r];
      fmt.mSampleRate = (Float64)chosenRate;
      status = AudioQueueNewInput(&fmt, paMicAQInputCallback, NULL, NULL, NULL, 0, &_paMicAudioQueue);
      if (status == noErr) break;
      _paMicAudioQueue = NULL;
    }
    if (status != noErr || _paMicAudioQueue == NULL) {
      [session setActive:NO withOptions:0 error:nil];
      reject(kPAErrCaptureError, @"AudioQueueNewInput failed", nil);
      return;
    }
    _paMicCaptureRate = chosenRate;

    UInt32 bufferByteSize = 2048;
    for (UInt32 i = 0; i < kPaMicAQNumberBuffers; i++) {
      status = AudioQueueAllocateBuffer(_paMicAudioQueue, bufferByteSize, &_paMicAQBuffers[i]);
      if (status != noErr) {
        paMicStopQueue();
        [session setActive:NO withOptions:0 error:nil];
        reject(kPAErrCaptureError, @"AudioQueueAllocateBuffer failed", nil);
        return;
      }
      AudioQueueEnqueueBuffer(_paMicAudioQueue, _paMicAQBuffers[i], 0, NULL);
    }

    _paMicAQRunning = YES;
    status = AudioQueueStart(_paMicAudioQueue, NULL);
    if (status != noErr) {
      paMicStopQueue();
      [session setActive:NO withOptions:0 error:nil];
      reject(kPAErrCaptureError, @"AudioQueueStart failed", nil);
      return;
    }

    resolve(nil);
  } @catch (NSException *e) {
    reject(kPAErrCaptureError, e.reason, nil);
  }
}

// ---- Mic: stop ----
- (void)stopMicToLiveAudioBuffer:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  paMicStopQueue();
  [[AVAudioSession sharedInstance] setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
  resolve(nil);
}
#endif

@end
