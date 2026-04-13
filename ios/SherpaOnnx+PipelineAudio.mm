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
#import "audio/SherpaOnnxAudioConvert.h"
#include "sherpa-onnx/c-api/cxx-api.h"
#include "PaLiveEntry.h"
#include <mutex>
#include <unordered_map>
#include <vector>
#include <string>
#include <set>
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

// Source constants, pa_resampleLinear, pa_writeWavHeaderToStream, pa_writeFloat32AsInt16Wav,
// and PaLiveEntry are defined in PaLiveEntry.h (included above).

// ==================== Resampler (int16 variant, not in header) ====================
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

// pa_writeWavHeaderToStream and pa_writeFloat32AsInt16Wav are provided by PaLiveEntry.h

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

// PaLiveEntry is defined in PaLiveEntry.h (included above).

// ==================== Registry ====================

// Non-static: shared with SherpaOnnx+STT.mm via SherpaOnnx+PipelineAudioGlobals.h
std::unordered_map<std::string, std::shared_ptr<PaOfflineEntry>> g_pa_offline;
std::unordered_map<std::string, std::shared_ptr<PaLiveEntry>> g_pa_live;
std::mutex g_pa_mutex;
static const long kPaFileBackedThreshold = 10L * 1024 * 1024; // 10 MB

std::shared_ptr<PaLiveEntry> pa_get_live_entry(const std::string &bufferId) {
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  auto it = g_pa_live.find(bufferId);
  if (it == g_pa_live.end()) {
    return nullptr;
  }
  return it->second;
}

bool pa_read_offline_samples(
  const std::string &bufferId,
  std::vector<float> *samples,
  int *sampleRate
) {
  std::shared_ptr<PaOfflineEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(bufferId);
    if (it == g_pa_offline.end() || !it->second) {
      return false;
    }
    entry = it->second;
  }

  if (sampleRate != nullptr) {
    *sampleRate = entry->sampleRate;
  }
  if (samples != nullptr) {
    *samples = entry->readAllSamples();
  }
  return true;
}

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

// ---- Convert pipeline buffer to format ----
- (void)convertPipelineAudioBufferToFormat:(NSString *)bufferId
                                outputPath:(NSString *)outputPath
                                    format:(NSString *)format
                        outputSampleRateHz:(NSNumber *)outputSampleRateHz
                                   resolve:(RCTPromiseResolveBlock)resolve
                                    reject:(RCTPromiseRejectBlock)reject
{
  int rate = outputSampleRateHz ? [outputSampleRateHz intValue] : 0;
  std::string fmt = [[format lowercaseString] UTF8String];

  // Format validation
  static const std::set<std::string> supportedFormats = {"wav","mp3","flac","aac","m4a","opus","webm","mkv","ogg"};
  if (supportedFormats.find(fmt) == supportedFormats.end()) {
    reject(@"CONVERSION_UNSUPPORTED_FORMAT",
           [NSString stringWithFormat:@"Unsupported format: %@", format], nil);
    return;
  }
  // Sample-rate validation
  if (rate < 0) {
    reject(@"CONVERSION_INVALID_SAMPLE_RATE", @"outputSampleRateHz must be >= 0", nil);
    return;
  }
  if (fmt == "mp3" && rate != 0 && rate != 32000 && rate != 44100 && rate != 48000) {
    reject(@"CONVERSION_INVALID_SAMPLE_RATE",
           [NSString stringWithFormat:@"MP3 sample rate must be 32000, 44100, 48000, or 0. Got: %d", rate], nil);
    return;
  }
  if ((fmt == "opus" || fmt == "ogg" || fmt == "webm" || fmt == "mkv") &&
      rate != 0 && rate != 8000 && rate != 12000 && rate != 16000 && rate != 24000 && rate != 48000) {
    reject(@"CONVERSION_INVALID_SAMPLE_RATE",
           [NSString stringWithFormat:@"Opus sample rate must be 8000, 12000, 16000, 24000, 48000, or 0. Got: %d", rate], nil);
    return;
  }

  std::string bid = [bufferId UTF8String];

  std::lock_guard<std::mutex> lock(g_pa_mutex);

  // Offline buffer?
  if (bid.rfind("off_", 0) == 0) {
    auto it = g_pa_offline.find(bid);
    if (it == g_pa_offline.end()) {
      reject(@"CONVERSION_BUFFER_NOT_FOUND", @"Offline buffer not found", nil); return;
    }
    auto &entry = it->second;
    if (entry->numSamples() == 0) {
      reject(@"CONVERSION_BUFFER_EMPTY", @"Buffer is empty", nil); return;
    }

    NSError *error = nil;
    if (entry->isFileBacked) {
      NSString *inPath = [NSString stringWithUTF8String:entry->filePath.c_str()];
      if (![SherpaOnnxAudioConvert convertAudioToFormat:inPath
                                             outputPath:outputPath
                                                 format:[NSString stringWithUTF8String:fmt.c_str()]
                                     outputSampleRateHz:rate
                                                  error:&error]) {
        reject(@"CONVERSION_CONVERT_ERROR", error ? error.localizedDescription : @"Conversion failed", error);
        return;
      }
    } else {
      if (![SherpaOnnxAudioConvert convertPcmToFormat:entry->samples.data()
                                           numSamples:(int)entry->samples.size()
                                           sampleRate:entry->sampleRate
                                         channelCount:entry->channelCount
                                           outputPath:outputPath
                                               format:[NSString stringWithUTF8String:fmt.c_str()]
                                   outputSampleRateHz:rate
                                                error:&error]) {
        reject(@"CONVERSION_CONVERT_ERROR", error ? error.localizedDescription : @"Conversion failed", error);
        return;
      }
    }
    resolve(nil);
    return;
  }

  // Live buffer?
  if (bid.rfind("live_", 0) == 0) {
    auto it = g_pa_live.find(bid);
    if (it == g_pa_live.end()) {
      reject(@"CONVERSION_BUFFER_NOT_FOUND", @"Live buffer not found", nil); return;
    }
    auto &entry = it->second;
    if (entry->state != PaLiveEntry::FINISHED) {
      reject(@"CONVERSION_BUFFER_NOT_FINALIZED", @"Live buffer must be finalized before conversion", nil); return;
    }
    if (entry->totalSamplesWritten == 0) {
      reject(@"CONVERSION_BUFFER_EMPTY", @"Buffer is empty", nil); return;
    }

    NSError *error = nil;
    if (entry->hasActiveSpool) {
      NSString *spoolPath = [NSString stringWithUTF8String:entry->spoolPath.c_str()];
      if (![SherpaOnnxAudioConvert convertAudioToFormat:spoolPath
                                             outputPath:outputPath
                                                 format:[NSString stringWithUTF8String:fmt.c_str()]
                                     outputSampleRateHz:rate
                                                  error:&error]) {
        reject(@"CONVERSION_CONVERT_ERROR", error ? error.localizedDescription : @"Conversion failed", error);
        return;
      }
    } else {
      auto snapshot = entry->snapshotRing();
      if (![SherpaOnnxAudioConvert convertPcmToFormat:snapshot.data()
                                           numSamples:(int)snapshot.size()
                                           sampleRate:entry->sampleRate
                                         channelCount:1
                                           outputPath:outputPath
                                               format:[NSString stringWithUTF8String:fmt.c_str()]
                                   outputSampleRateHz:rate
                                                error:&error]) {
        reject(@"CONVERSION_CONVERT_ERROR", error ? error.localizedDescription : @"Conversion failed", error);
        return;
      }
    }
    resolve(nil);
    return;
  }

  reject(@"CONVERSION_INVALID_ARGUMENT", @"Invalid buffer ID prefix: expected off_ or live_", nil);
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
