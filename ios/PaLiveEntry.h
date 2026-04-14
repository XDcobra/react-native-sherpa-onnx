#pragma once

/**
 * PaLiveEntry — Live audio buffer entry for the pipeline audio registry (iOS).
 *
 * Extracted to a header so that streaming pipeline workers (EnhancementPipelineWorker, etc.)
 * can access PaLiveEntry members. The actual registry globals live in SherpaOnnx+PipelineAudioGlobals.h.
 */

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#ifdef __OBJC__
#import <Foundation/Foundation.h>
#include <CoreFoundation/CoreFoundation.h>
#endif

// ==================== Source constants ====================
static const char *kPaAppendSourceMic = "mic";
static const char *kPaAppendSourceAppend = "append";
static const char *kPaAppendSourceAppendOffline = "append_offline";
static const char *kPaAppendSourceEnhancement = "enhancement";
static const char *kPaAppendSourceTts = "tts";
static const char *kPaAppendSourceUnknown = "unknown";
static const char *kPaAppendSourceMixed = "mixed";

// ==================== Inline utility functions ====================

inline std::vector<float> pa_resampleLinear(const float *input, size_t inputSize, int inputRate, int outputRate) {
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

inline void pa_writeWavHeaderToStream(std::ofstream &f, int sampleRate, int bitsPerSample, int audioFormat, int dataSize) {
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

// ==================== PaLiveEntry ====================

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
  std::mutex cursorMutex;

  // Append events (JS callback)
  bool appendEventsEnabled = false;
  int appendEventMinIntervalMs = 0;
  std::function<void(const std::string &, int, int64_t)> onFramesAppended;
  std::mutex appendEventMutex;
  uint64_t lastAppendEventAtMs = 0;
  int pendingFrames = 0;
  std::string pendingSource;

  // Token-based native append listener system for pipeline workers.
  struct NativeAppendListener {
    int token;
    std::function<void()> callback;
  };
  std::vector<NativeAppendListener> nativeAppendListeners;
  std::mutex nativeAppendListenerMutex;
  int nextListenerToken_ = 0;

  /** Add a listener and return a unique token for removal. */
  int addAppendListener(std::function<void()> listener) {
    std::lock_guard<std::mutex> lock(nativeAppendListenerMutex);
    int token = nextListenerToken_++;
    nativeAppendListeners.push_back({token, std::move(listener)});
    return token;
  }

  /** Remove a listener by its token. Safe even if index shifts. */
  void removeAppendListener(int token) {
    std::lock_guard<std::mutex> lock(nativeAppendListenerMutex);
    for (auto it = nativeAppendListeners.begin(); it != nativeAppendListeners.end(); ++it) {
      if (it->token == token) {
        nativeAppendListeners.erase(it);
        return;
      }
    }
  }

  size_t appendListenerCount() {
    std::lock_guard<std::mutex> lock(nativeAppendListenerMutex);
    return nativeAppendListeners.size();
  }

  void notifyAppendListeners() {
    std::lock_guard<std::mutex> lock(nativeAppendListenerMutex);
    for (auto &entry : nativeAppendListeners) {
      entry.callback();
    }
  }

  PaLiveEntry(const std::string &bid, int sr, int ch, double windowSec,
              const std::string &spoolPathArg, bool spoolFloat,
              bool emitAppendedEvents,
              int appendEventMinIntervalMsArg,
              std::function<void(const std::string &, int, int64_t)> onFramesAppendedArg)
    : bufferId(bid), sampleRate(sr), channelCount(ch) {
    appendEventsEnabled = emitAppendedEvents;
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

#ifdef __OBJC__
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
#endif

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

    dispatchFramesAppended(appendCount, source);

    // Notify native pipeline listeners (immediate, no throttling)
    notifyAppendListeners();
  }

  void configureAppendEvents(bool enabled, int minIntervalMs) {
    std::lock_guard<std::mutex> lock(appendEventMutex);
    appendEventsEnabled = enabled;
    appendEventMinIntervalMs = std::max(0, minIntervalMs);
    if (!appendEventsEnabled) {
      pendingFrames = 0;
      pendingSource.clear();
    }
  }

  void dispatchFramesAppended(size_t appendedCount, const std::string &source) {
    if (!appendEventsEnabled || !onFramesAppended) return;

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

#ifdef __OBJC__
      uint64_t nowMs = (uint64_t)(CFAbsoluteTimeGetCurrent() * 1000.0);
#else
      uint64_t nowMs = 0; // Fallback, not used in non-ObjC context
#endif
      bool intervalReached = appendEventMinIntervalMs <= 0 ||
                             lastAppendEventAtMs == 0 ||
                             (nowMs - lastAppendEventAtMs) >= (uint64_t)appendEventMinIntervalMs;

      if (intervalReached && pendingFrames > 0) {
        frameCountToEmit = pendingFrames;
        sourceToEmit = pendingSource.empty() ? kPaAppendSourceUnknown : pendingSource;
        totalWrittenToEmit = totalSamplesWritten;
        pendingFrames = 0;
        pendingSource.clear();
        lastAppendEventAtMs = nowMs;
        shouldEmit = true;
      }
    }

    if (shouldEmit && onFramesAppended) {
      onFramesAppended(sourceToEmit, frameCountToEmit, totalWrittenToEmit);
    }
  }

  void flushPendingFramesAppended() {
    if (!appendEventsEnabled || !onFramesAppended) return;

    std::string sourceToEmit;
    int frameCountToEmit = 0;
    int64_t totalWrittenToEmit = 0;

    {
      std::lock_guard<std::mutex> lock(appendEventMutex);
      if (pendingFrames <= 0) return;

      frameCountToEmit = pendingFrames;
      sourceToEmit = pendingSource.empty() ? kPaAppendSourceUnknown : pendingSource;
      totalWrittenToEmit = totalSamplesWritten;

      pendingFrames = 0;
      pendingSource.clear();
#ifdef __OBJC__
      lastAppendEventAtMs = (uint64_t)(CFAbsoluteTimeGetCurrent() * 1000.0);
#endif
    }

    onFramesAppended(sourceToEmit, frameCountToEmit, totalWrittenToEmit);
  }

  void finalize_() {
    if (state == FINISHED) return;
    state = FINISHED;

    if (hasActiveSpool && spoolFile.is_open()) {
      spoolFile.flush();
      int bytesPerSample = spoolIsFloat ? 4 : 2;
      int64_t dataSize = spoolSamplesWritten * bytesPerSample;

      spoolFile.seekp(4, std::ios::beg);
      uint32_t riffSize = (uint32_t)(44 + dataSize - 8);
      spoolFile.write(reinterpret_cast<char*>(&riffSize), 4);

      spoolFile.seekp(40, std::ios::beg);
      uint32_t dataSz = (uint32_t)dataSize;
      spoolFile.write(reinterpret_cast<char*>(&dataSz), 4);

      spoolFile.close();
    }

    flushPendingFramesAppended();

    // Wake pipeline workers so they detect the FINISHED state immediately
    notifyAppendListeners();
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
    std::lock_guard<std::mutex> cLock(cursorMutex);
    int id = nextCursorId++;
    int64_t startPos = (totalSamplesWritten > windowCapacity) ? totalSamplesWritten - windowCapacity : 0;
    cursors[id] = { id, startPos };
    return id;
  }

  std::vector<float> drainCursor(int cursorId, int maxSamples) {
    std::lock_guard<std::mutex> cLock(cursorMutex);
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

  void releaseCursor(int cursorId) {
    std::lock_guard<std::mutex> cLock(cursorMutex);
    cursors.erase(cursorId);
  }

  void release() {
    if (state == RECORDING) finalize_();
    flushPendingFramesAppended();
    if (spoolFile.is_open()) spoolFile.close();
    cursors.clear();
  }
};
