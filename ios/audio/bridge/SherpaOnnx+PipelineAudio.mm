/**
 * SherpaOnnx+PipelineAudio.mm
 *
 * Unified pipeline audio buffer registry for iOS.
 * Mirrors the Kotlin PipelineAudioRegistry with two buffer kinds:
 * - OfflineEntry: immutable PCM (in-memory or file-backed)
 * - LiveEntry: streaming PCM with ring buffer, optional WAV spool, consumer cursors
 *
 * Implements all TurboModule methods for createOfflineAudioBuffer*, createEmptyLiveAudioBuffer,
 * appendSamples*, finalize, save, info, release, and file ingest.
 * Mic capture methods are implemented in SherpaOnnx+PipelineAudioMic.mm.
 */

#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>
#import "fileio/FileIOResolver.h"
#import "fileio/FileIOStreamCopy.h"
#include "sherpa-onnx/c-api/cxx-api.h"
#include "PaLiveEntry.h"
#include "AudioRegistry.h"
#include "AudioDecodeSession.h"
#include "AudioEncodeSession.h"
#include "AudioVisualization.h"
#include "AudioVisualizationSidecar.h"
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <string>
#include <set>
#include <fstream>
#include <functional>
#include <algorithm>
#include <cmath>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <cerrno>
#include <thread>
#include <memory>
#include <stdexcept>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

// ==================== Error Codes ====================
static dispatch_queue_t SherpaAudioDecodeQueue(void) {
  static dispatch_once_t onceToken;
  static dispatch_queue_t queue;
  dispatch_once(&onceToken, ^{
    queue = dispatch_queue_create("com.sherpaonnx.audio-decode", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

static NSString *const kPAErrBufferNotFound   = @"AUDIO_BUFFER_NOT_FOUND";
static NSString *const kPAErrInvalidArgument  = @"AUDIO_INVALID_ARGUMENT";
static NSString *const kPAErrInvalidState     = @"AUDIO_INVALID_STATE";
static NSString *const kPAErrFileNotFound     = @"AUDIO_FILE_NOT_FOUND";
static NSString *const kPAErrFileReadError    = @"AUDIO_FILE_READ_ERROR";
static NSString *const kPAErrFileWriteError   = @"AUDIO_FILE_WRITE_ERROR";
static NSString *const kPAErrAlreadyFinalized = @"AUDIO_ALREADY_FINALIZED";
static NSString *const kPAErrTransferInvalidState = @"TRANSFER_INVALID_STATE";
static NSString *const kPAErrTransferSpoolUnavailable = @"TRANSFER_SPOOL_UNAVAILABLE";
static NSString *const kPAErrTransferCursorsActive = @"TRANSFER_CURSORS_ACTIVE";
static NSString *const kPAErrBufferInvalidated = @"BUFFER_INVALIDATED";
static NSString *const kPAErrInternalError    = @"AUDIO_INTERNAL_ERROR";

// Source constants, pa_resampleLinear, pa_writeWavHeaderToStream, and PaLiveEntry are defined in PaLiveEntry.h (included above).

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

// pa_writeWavHeaderToStream is provided by PaLiveEntry.h

// PaMmapRegion / PaOfflineEntry / registry SoT: android/src/main/cpp/audiobuffer/
// (AudioRegistry.h / PaOfflineEntry.h / PaLiveEntry.h)

// PaLiveEntry is defined in PaLiveEntry.h (included above).

// ==================== Registry ====================

// g_pa_* registry lives in AudioRegistry.cpp; cancel maps stay bridge-local.
static std::unordered_map<std::string, std::shared_ptr<std::atomic<bool>>> g_pa_saveCancelFlags;
static std::mutex g_pa_saveCancelMutex;
static std::unordered_map<std::string, std::shared_ptr<std::atomic<bool>>> g_pa_decodeCancelFlags;
static std::mutex g_pa_decodeCancelMutex;

struct PaFileIngestStatus {
  bool isRunning = true;
  int64_t framesIngested = 0;
  int64_t totalFramesEstimate = 0;
  int percent = 0;
  std::string error;
};

struct PaVisualizationOptions {
  int barCount = 96;
  double minHz = 60.0;
  double maxHz = 0.0;
  int fftSize = 2048;
  int hopSize = 1024;
  bool includeTimeline = false;
  int frameCount = 0;
  double frameDurationMs = 0.0;
  double maxAnalysisDurationMs = 0.0;
  int levelsMaxStftFrames = 1024;
  int analysisSampleRateHz = 0;
  NSString *progressOperationId = nil;
  sherpa::AudioVisualizationAggregateMode aggregateMode =
      sherpa::AudioVisualizationAggregateMode::MAX_HOLD;
};

static void pa_emitVisualizationProgress(
  __weak SherpaOnnx *weakEmitter,
  NSString *operationId,
  NSString *phase,
  double phasePercent,
  int64_t framesDecoded,
  int64_t totalFramesEstimate,
  int64_t stftWindowsDone,
  int64_t stftWindowsTotal
) {
  if (!operationId || operationId.length == 0) {
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    SherpaOnnx *emitter = weakEmitter;
    if (!emitter) {
      return;
    }
    [emitter sendEventWithName:@"visualizationProgress" body:@{
      @"operationId": operationId,
      @"phase": phase ?: @"analysis",
      @"phasePercent": @(std::max(0.0, std::min(1.0, phasePercent))),
      @"framesDecoded": @((double)framesDecoded),
      @"totalFramesEstimate": @((double)totalFramesEstimate),
      @"stftWindowsDone": @((double)stftWindowsDone),
      @"stftWindowsTotal": @((double)stftWindowsTotal),
    }];
  });
}

static bool pa_parseVisualizationOptions(
  NSDictionary *options,
  PaVisualizationOptions &out,
  NSString **errCode,
  NSString **errMsg
) {
  NSString *kind = options[@"kind"];
  if (kind != nil && ![kind isEqualToString:@"spectrum_bars"]) {
    if (errCode) *errCode = @"AUDIO_VISUALIZATION_INVALID_OPTIONS";
    if (errMsg) *errMsg = @"kind must be 'spectrum_bars'";
    return false;
  }

  NSString *timeAggregate = options[@"timeAggregate"];
  if (timeAggregate != nil) {
    if ([timeAggregate isEqualToString:@"max_hold"]) {
      out.aggregateMode = sherpa::AudioVisualizationAggregateMode::MAX_HOLD;
    } else if ([timeAggregate isEqualToString:@"mean"]) {
      out.aggregateMode = sherpa::AudioVisualizationAggregateMode::MEAN;
    } else {
      if (errCode) *errCode = @"AUDIO_VISUALIZATION_INVALID_OPTIONS";
      if (errMsg) *errMsg = @"timeAggregate must be 'max_hold' or 'mean'";
      return false;
    }
  }

  NSNumber *barCount = options[@"barCount"];
  if (barCount != nil) {
    out.barCount = std::max(8, std::min(512, [barCount intValue]));
  }

  NSNumber *minHz = options[@"minHz"];
  if (minHz != nil) {
    out.minHz = std::max(10.0, [minHz doubleValue]);
  }

  NSNumber *maxHz = options[@"maxHz"];
  if (maxHz != nil) {
    out.maxHz = [maxHz doubleValue];
  }

  NSNumber *frameCount = options[@"frameCount"];
  NSNumber *frameDurationMs = options[@"frameDurationMs"];
  NSNumber *includeTimeline = options[@"includeTimeline"];

  const bool hasFrameCount = frameCount != nil && [frameCount intValue] > 0;
  const bool hasFrameDuration = frameDurationMs != nil;
  out.includeTimeline =
    (includeTimeline != nil && [includeTimeline boolValue]) ||
    hasFrameCount ||
    hasFrameDuration;

  if (hasFrameCount) {
    out.frameCount = [frameCount intValue];
    if (out.frameCount < 8 || out.frameCount > 512) {
      if (errCode) *errCode = @"AUDIO_VISUALIZATION_INVALID_OPTIONS";
      if (errMsg) *errMsg = @"frameCount must be between 8 and 512";
      return false;
    }
    out.frameDurationMs = 0.0;
  } else if (hasFrameDuration) {
    out.frameDurationMs = [frameDurationMs doubleValue];
    if (out.frameDurationMs < 50.0 || out.frameDurationMs > 10000.0) {
      if (errCode) *errCode = @"AUDIO_VISUALIZATION_INVALID_OPTIONS";
      if (errMsg) *errMsg = @"frameDurationMs must be between 50 and 10000";
      return false;
    }
  }

  if (out.includeTimeline && out.frameCount <= 0 && out.frameDurationMs <= 0.0) {
    out.frameDurationMs = 500.0;
  }

  NSNumber *maxAnalysisDurationMs = options[@"maxAnalysisDurationMs"];
  if (maxAnalysisDurationMs != nil) {
    out.maxAnalysisDurationMs = std::max(0.0, [maxAnalysisDurationMs doubleValue]);
  }

  NSNumber *levelsMaxStftFrames = options[@"levelsMaxStftFrames"];
  if (levelsMaxStftFrames != nil) {
    out.levelsMaxStftFrames = std::max(64, std::min(4096, [levelsMaxStftFrames intValue]));
  }

  NSNumber *analysisSampleRateHz = options[@"analysisSampleRateHz"];
  if (analysisSampleRateHz != nil) {
    const int raw = [analysisSampleRateHz intValue];
    if (raw == 0) {
      out.analysisSampleRateHz = 0;
    } else if (raw >= 4000 && raw <= 96000) {
      out.analysisSampleRateHz = raw;
    } else {
      if (errCode) *errCode = @"AUDIO_VISUALIZATION_INVALID_OPTIONS";
      if (errMsg) *errMsg = @"analysisSampleRateHz must be 0 or between 4000 and 96000";
      return false;
    }
  }

  NSString *progressOperationId = options[@"progressOperationId"];
  if (progressOperationId != nil) {
    NSString *trimmed = [progressOperationId stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (trimmed.length > 0) {
      out.progressOperationId = trimmed;
    }
  }

  return true;
}

static sherpa::AudioVisualizationConfig pa_makeVisualizationConfig(
  int sampleRate,
  const PaVisualizationOptions &options
) {
  sherpa::AudioVisualizationConfig cfg;
  cfg.sampleRate = std::max(1, sampleRate);
  cfg.barCount = options.barCount;
  cfg.minHz = static_cast<float>(options.minHz);
  cfg.maxHz = static_cast<float>(options.maxHz);
  cfg.fftSize = options.fftSize;
  cfg.hopSize = options.hopSize;
  cfg.aggregateMode = options.aggregateMode;
  cfg.timeline.enabled = options.includeTimeline || options.frameCount > 0 || options.frameDurationMs > 0.0;
  cfg.timeline.frameCount = options.frameCount;
  cfg.timeline.frameDurationMs = options.frameDurationMs;
  cfg.timeline.maxAnalysisSamples =
    options.maxAnalysisDurationMs > 0.0
      ? static_cast<int64_t>((cfg.sampleRate * options.maxAnalysisDurationMs) / 1000.0)
      : 0;
  cfg.levels.maxStftFrames =
    cfg.timeline.enabled ? 0 : std::max(0, options.levelsMaxStftFrames);
  return cfg;
}

static sherpa::AudioVisualizationProfile pa_computeVisualizationFromSamples(
  const float *samples,
  int sampleCount,
  int sampleRate,
  const PaVisualizationOptions &options,
  __weak SherpaOnnx *progressEmitter
) {
  auto cfg = pa_makeVisualizationConfig(sampleRate, options);
  sherpa::AudioVisualizationAccumulator accumulator(cfg);
  if (!options.includeTimeline && sampleCount > 0) {
    accumulator.setExpectedTotalSamples(static_cast<int64_t>(sampleCount));
  }
  if (options.progressOperationId.length > 0) {
    NSString *opId = options.progressOperationId;
    accumulator.setAnalysisProgressCallback(
      [progressEmitter, opId](int64_t stftDone, int64_t stftTotal) {
        const double pct = static_cast<double>(stftDone) /
          static_cast<double>(std::max<int64_t>(1, stftTotal));
        pa_emitVisualizationProgress(
          progressEmitter,
          opId,
          @"analysis",
          pct,
          0,
          0,
          stftDone,
          stftTotal);
      });
  }
  if (samples != nullptr && sampleCount > 0) {
    accumulator.feed(samples, sampleCount);
  }
  return accumulator.finish();
}

static sherpa::AudioVisualizationProfile pa_computeVisualizationFromFile(
  const std::string &path,
  const PaVisualizationOptions &options,
  __weak SherpaOnnx *progressEmitter
) {
  sherpa::AudioDecodeConfig decodeConfig;
  decodeConfig.targetSampleRate =
    options.analysisSampleRateHz > 0 ? options.analysisSampleRateHz : 0;
  decodeConfig.forceMono = true;
  decodeConfig.chunkSize = 8192;
  decodeConfig.allowDemuxerAutoProbe = true;

  int64_t probedDurationMs = -1;
  try {
    const auto probeResult = sherpa::probeFileDuration(path.c_str(), -1);
    probedDurationMs = probeResult.durationMs;
  } catch (...) {
    probedDurationMs = -1;
  }

  std::atomic<bool> cancelFlag(false);
  std::unique_ptr<sherpa::AudioVisualizationAccumulator> accumulator;
  int outputSampleRate = 16000;
  const bool hasProgress = options.progressOperationId.length > 0;
  NSString *progressOpId = options.progressOperationId;

  auto attachAnalysisProgress = [&](sherpa::AudioVisualizationAccumulator &acc) {
    if (!hasProgress) {
      return;
    }
    acc.setAnalysisProgressCallback(
      [progressEmitter, progressOpId](int64_t stftDone, int64_t stftTotal) {
        const double pct = static_cast<double>(stftDone) /
          static_cast<double>(std::max<int64_t>(1, stftTotal));
        pa_emitVisualizationProgress(
          progressEmitter,
          progressOpId,
          @"analysis",
          pct,
          0,
          0,
          stftDone,
          stftTotal);
      });
  };

  auto onStreamInfo = [&](int sourceSampleRate, int /* sourceChannels */) {
    outputSampleRate = options.analysisSampleRateHz > 0
      ? options.analysisSampleRateHz
      : (sourceSampleRate > 0 ? sourceSampleRate : 16000);
    auto cfg = pa_makeVisualizationConfig(outputSampleRate, options);
    accumulator = std::make_unique<sherpa::AudioVisualizationAccumulator>(cfg);
    if (probedDurationMs > 0 && !options.includeTimeline) {
      const int64_t expectedSamples =
          (probedDurationMs * static_cast<int64_t>(outputSampleRate)) / 1000;
      accumulator->setExpectedTotalSamples(expectedSamples);
    }
    attachAnalysisProgress(*accumulator);
  };

  auto onChunk = [&](const float *samples, int frameCount) {
    if (!accumulator) {
      auto cfg = pa_makeVisualizationConfig(outputSampleRate, options);
      accumulator = std::make_unique<sherpa::AudioVisualizationAccumulator>(cfg);
      attachAnalysisProgress(*accumulator);
    }
    accumulator->feed(samples, frameCount);
    if (accumulator->isAnalysisCapReached()) {
      cancelFlag.store(true, std::memory_order_relaxed);
    }
  };

  sherpa::DecodeProgressCallback onDecodeProgress = nullptr;
  if (hasProgress) {
    onDecodeProgress = [progressEmitter, progressOpId](
        int64_t framesDecoded, int64_t totalEstimate, int percent) {
      pa_emitVisualizationProgress(
        progressEmitter,
        progressOpId,
        @"decode",
        static_cast<double>(percent) / 100.0,
        framesDecoded,
        totalEstimate,
        0,
        0);
    };
  }

  auto decodeResult = sherpa::decodeFile(
    path.c_str(),
    decodeConfig,
    onChunk,
    onDecodeProgress,
    onStreamInfo,
    cancelFlag
  );

  if (!accumulator) {
    auto cfg = pa_makeVisualizationConfig(
      decodeResult.sourceSampleRate > 0 ? decodeResult.sourceSampleRate : 16000,
      options
    );
    accumulator = std::make_unique<sherpa::AudioVisualizationAccumulator>(cfg);
  }

  return accumulator->finish();
}

static NSDictionary *pa_visualizationProfileToDict(
  sherpa::AudioVisualizationProfile profile
) {
  NSMutableArray *levels = [NSMutableArray arrayWithCapacity:profile.levels.size()];
  for (float raw : profile.levels) {
    double clamped = std::max(0.0, std::min(1.0, static_cast<double>(raw)));
    [levels addObject:@(clamped)];
  }

  NSString *framesTransferId = nil;
  if (profile.frameCount > 0 && !profile.frames.empty()) {
    std::string transferId = sherpa::storeVisualizationFramesForTransfer(std::move(profile.frames));
    if (!transferId.empty()) {
      framesTransferId = [NSString stringWithUTF8String:transferId.c_str()];
    }
  }

  NSMutableDictionary *out = [@{
    @"kind": @"spectrum_bars",
    @"sampleRate": @(std::max(0, profile.sampleRate)),
    @"durationMs": @(std::max<int64_t>(0, profile.durationMs)),
    @"barCount": @(profile.barCount),
    @"levels": levels,
    @"frameCount": @(std::max(0, profile.frameCount)),
    @"frameDurationMs": @(std::max(0.0, profile.frameDurationMs)),
  } mutableCopy];

  if (framesTransferId != nil && framesTransferId.length > 0) {
    out[@"framesTransferId"] = framesTransferId;
  }

  return out;
}

static std::unordered_map<std::string, std::shared_ptr<PaFileIngestStatus>> g_pa_fileIngestStatuses;
static std::mutex g_pa_fileIngestMutex;

// pa_generate_id: AudioRegistry.cpp


// Threshold / tempDir / pa_* registry helpers: AudioRegistry.cpp
// Bridge keeps TurboModule methods below.

static std::string pa_tempDir() {
  return pa_temp_dir();
}

@implementation SherpaOnnx (PipelineAudio)

#if __has_include(<SherpaOnnxSpec/SherpaOnnxSpec.h>)

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

    std::string bufferId = pa_generate_id("off");
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

// ---- Offline: decode file (parity with Android decodeFileToOfflineBuffer + decodeProgress) ----
- (void)decodeFileToOfflineBuffer:(NSDictionary *)source
               targetSampleRateHz:(double)targetSampleRateHz
                        forceMono:(BOOL)forceMono
              allowDemuxerAutoProbe:(BOOL)allowDemuxerAutoProbe
                      operationId:(NSString *)operationId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  (void)allowDemuxerAutoProbe;
  if (!source || [source count] == 0) {
    reject(kPAErrInvalidArgument, @"source is required", nil);
    return;
  }
  if (!operationId || [operationId length] == 0) {
    reject(kPAErrInvalidArgument, @"operationId is required", nil);
    return;
  }

  auto cancelFlag = std::make_shared<std::atomic<bool>>(false);
  std::string opId = [operationId UTF8String];
  {
    std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
    g_pa_decodeCancelFlags[opId] = cancelFlag;
  }

  NSString *errCode = nil;
  NSString *errMsg = nil;
  FileIOReadHandle *readHandle = [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
  if (!readHandle) {
    {
      std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
      g_pa_decodeCancelFlags.erase(opId);
    }
    reject(errCode ?: kPAErrFileNotFound, errMsg ?: @"Failed to resolve audio source", nil);
    return;
  }

  NSString *sourcePath = nil;
  NSString *tmpPath = nil;
  if (readHandle.isFilePath) {
    sourcePath = readHandle.filePath;
  } else {
    tmpPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
               [NSString stringWithFormat:@"fileio_buf_%@", [[NSUUID UUID] UUIDString]]];
    NSOutputStream *out = [NSOutputStream outputStreamToFileAtPath:tmpPath append:NO];
    [out open];
    [readHandle.stream open];
    uint8_t buf[65536];
    NSInteger bytesRead;
    while ((bytesRead = [readHandle.stream read:buf maxLength:sizeof(buf)]) > 0) {
      [out write:buf maxLength:bytesRead];
    }
    [out close];
    sourcePath = tmpPath;
  }

  __weak SherpaOnnx *weakSelf = self;
  std::string path = [sourcePath UTF8String];
  NSString *tmpPathCleanup = tmpPath;
  int targetRate = (int)targetSampleRateHz;

  dispatch_async(SherpaAudioDecodeQueue(), ^{
    @autoreleasepool {
      NSString *outF32 = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"pa_off_decode_%@.f32", [[NSUUID UUID] UUIDString]]];
      std::string outPathStr = [outF32 UTF8String];
      FILE *outFile = fopen(outPathStr.c_str(), "wb");
      if (!outFile) {
        [readHandle cleanup];
        if (tmpPathCleanup) {
          [[NSFileManager defaultManager] removeItemAtPath:tmpPathCleanup error:nil];
        }
        {
          std::lock_guard<std::mutex> lk(g_pa_decodeCancelMutex);
          g_pa_decodeCancelFlags.erase(opId);
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(@"DECODE_INTERNAL_ERROR", @"Cannot open temp file for decoded PCM", nil);
        });
        return;
      }

      int64_t totalSamplesWritten = 0;
      bool writeError = false;
      auto onChunk = [&](const float *samples, int count) {
        if (writeError || cancelFlag->load()) return;
        size_t w = fwrite(samples, sizeof(float), (size_t)count, outFile);
        if ((int)w != count) {
          writeError = true;
        } else {
          totalSamplesWritten += count;
        }
      };

      int srcSampleRate = 0;
      int srcChannels = 0;
      auto onStreamInfo = [&srcSampleRate, &srcChannels](int sr, int ch) {
        srcSampleRate = sr;
        srcChannels = ch;
      };

      auto onProgress = [weakSelf, operationId, &srcSampleRate, &srcChannels](
          int64_t framesDecoded, int64_t totalEstimate, int percent) {
        SherpaOnnx *strongSelf = weakSelf;
        if (!strongSelf) return;
        dispatch_async(dispatch_get_main_queue(), ^{
          [strongSelf sendEventWithName:@"decodeProgress" body:@{
            @"operationId": operationId,
            @"framesDecoded": @((double)framesDecoded),
            @"totalFramesEstimate": @((double)totalEstimate),
            @"percent": @(percent),
            @"sourceSampleRate": @(srcSampleRate),
            @"sourceChannels": @(srcChannels),
          }];
        });
      };

      try {
        sherpa::AudioDecodeConfig config;
        config.targetSampleRate = targetRate;
        config.forceMono = forceMono;
        config.chunkSize = 8192;

        auto result = sherpa::decodeFile(path.c_str(), config, onChunk, onProgress, onStreamInfo, *cancelFlag);
        fclose(outFile);
        outFile = NULL;

        [readHandle cleanup];
        if (tmpPathCleanup) {
          [[NSFileManager defaultManager] removeItemAtPath:tmpPathCleanup error:nil];
        }

        if (writeError) {
          unlink(outPathStr.c_str());
          {
            std::lock_guard<std::mutex> lk(g_pa_decodeCancelMutex);
            g_pa_decodeCancelFlags.erase(opId);
          }
          dispatch_async(dispatch_get_main_queue(), ^{
            reject(@"DECODE_INTERNAL_ERROR", @"Write error while decoding audio", nil);
          });
          return;
        }

        int numSamples = (int)totalSamplesWritten;
        int srcSr = result.sourceSampleRate > 0 ? result.sourceSampleRate : srcSampleRate;
        int outSampleRate = targetRate > 0 ? targetRate : (srcSr > 0 ? srcSr : 16000);
        if (outSampleRate <= 0) {
          outSampleRate = 16000;
        }

        if (numSamples <= 0) {
          unlink(outPathStr.c_str());
          {
            std::lock_guard<std::mutex> lk(g_pa_decodeCancelMutex);
            g_pa_decodeCancelFlags.erase(opId);
          }
          dispatch_async(dispatch_get_main_queue(), ^{
            reject(@"DECODE_EMPTY", @"No samples decoded", nil);
          });
          return;
        }

        long rawSize = (long)numSamples * 4L;
        long threshold = pa_file_origin_threshold_bytes();
        std::string bufferId = pa_generate_id("off");

        std::shared_ptr<PaOfflineEntry> entry = std::make_shared<PaOfflineEntry>();
        entry->bufferId = bufferId;
        entry->sampleRate = outSampleRate;
        entry->channelCount = 1;

        if (rawSize >= threshold) {
          auto region = PaMmapRegion::mapFile(outPathStr, 0, true);
          if (!region) {
            unlink(outPathStr.c_str());
            {
              std::lock_guard<std::mutex> lk(g_pa_decodeCancelMutex);
              g_pa_decodeCancelFlags.erase(opId);
            }
            dispatch_async(dispatch_get_main_queue(), ^{
              reject(kPAErrInternalError, @"Failed to mmap decoded audio", nil);
            });
            return;
          }
          entry->mmapRegion = std::move(region);
        } else {
          std::vector<float> samples((size_t)numSamples);
          FILE *rf = fopen(outPathStr.c_str(), "rb");
          if (!rf) {
            unlink(outPathStr.c_str());
            {
              std::lock_guard<std::mutex> lk(g_pa_decodeCancelMutex);
              g_pa_decodeCancelFlags.erase(opId);
            }
            dispatch_async(dispatch_get_main_queue(), ^{
              reject(kPAErrInternalError, @"Failed to read decoded audio", nil);
            });
            return;
          }
          size_t nread = fread(samples.data(), sizeof(float), (size_t)numSamples, rf);
          fclose(rf);
          unlink(outPathStr.c_str());
          if (nread != (size_t)numSamples) {
            {
              std::lock_guard<std::mutex> lk(g_pa_decodeCancelMutex);
              g_pa_decodeCancelFlags.erase(opId);
            }
            dispatch_async(dispatch_get_main_queue(), ^{
              reject(kPAErrInternalError, @"Short read of decoded audio", nil);
            });
            return;
          }
          entry->samples = std::move(samples);
        }

        {
          std::lock_guard<std::mutex> lock(g_pa_mutex);
          g_pa_offline[bufferId] = entry;
        }
        {
          std::lock_guard<std::mutex> lk(g_pa_decodeCancelMutex);
          g_pa_decodeCancelFlags.erase(opId);
        }

        NSDictionary *dict = entry->toDict();
        dispatch_async(dispatch_get_main_queue(), ^{
          resolve(dict);
        });
      } catch (const std::runtime_error &e) {
        if (outFile) {
          fclose(outFile);
        }
        unlink(outPathStr.c_str());
        [readHandle cleanup];
        if (tmpPathCleanup) {
          [[NSFileManager defaultManager] removeItemAtPath:tmpPathCleanup error:nil];
        }
        {
          std::lock_guard<std::mutex> lk(g_pa_decodeCancelMutex);
          g_pa_decodeCancelFlags.erase(opId);
        }
        std::string msg = e.what();
        NSString *nsMsg = [NSString stringWithUTF8String:msg.c_str()];
        NSString *nsCode = @"DECODE_INTERNAL_ERROR";
        if (msg.find("DECODE_") == 0) {
          auto colonPos = msg.find(':');
          if (colonPos != std::string::npos) {
            nsCode = [NSString stringWithUTF8String:msg.substr(0, colonPos).c_str()];
          }
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(nsCode, nsMsg, nil);
        });
      } catch (...) {
        if (outFile) {
          fclose(outFile);
        }
        unlink(outPathStr.c_str());
        [readHandle cleanup];
        if (tmpPathCleanup) {
          [[NSFileManager defaultManager] removeItemAtPath:tmpPathCleanup error:nil];
        }
        {
          std::lock_guard<std::mutex> lk(g_pa_decodeCancelMutex);
          g_pa_decodeCancelFlags.erase(opId);
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(@"DECODE_INTERNAL_ERROR", @"Unknown error during file decode", nil);
        });
      }
    }
  });
}

// ---- Duration probe (container metadata only, no decode) ----
- (void)probeAudioFileDuration:(NSDictionary *)source
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  if (!source || [source count] == 0) {
    reject(kPAErrInvalidArgument, @"source is required", nil);
    return;
  }

  NSString *errCode = nil;
  NSString *errMsg = nil;
  FileIOReadHandle *readHandle = [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
  if (!readHandle) {
    reject(errCode ?: kPAErrFileNotFound, errMsg ?: @"Failed to resolve audio source", nil);
    return;
  }

  NSString *sourcePath = nil;
  NSString *tmpPath = nil;
  if (readHandle.isFilePath) {
    sourcePath = readHandle.filePath;
  } else {
    tmpPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
               [NSString stringWithFormat:@"fileio_probe_%@", [[NSUUID UUID] UUIDString]]];
    NSOutputStream *out = [NSOutputStream outputStreamToFileAtPath:tmpPath append:NO];
    [out open];
    [readHandle.stream open];
    uint8_t buf[65536];
    NSInteger bytesRead;
    while ((bytesRead = [readHandle.stream read:buf maxLength:sizeof(buf)]) > 0) {
      [out write:buf maxLength:bytesRead];
    }
    [out close];
    sourcePath = tmpPath;
  }

  std::string path = [sourcePath UTF8String];
  NSString *tmpPathCleanup = tmpPath;

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    @autoreleasepool {
      try {
        auto result = sherpa::probeFileDuration(path.c_str(), -1);
        [readHandle cleanup];
        if (tmpPathCleanup) {
          [[NSFileManager defaultManager] removeItemAtPath:tmpPathCleanup error:nil];
        }

        if (result.durationMs < 0) {
          dispatch_async(dispatch_get_main_queue(), ^{
            reject(@"PROBE_DURATION_UNKNOWN", @"Could not determine duration", nil);
          });
          return;
        }

        dispatch_async(dispatch_get_main_queue(), ^{
          resolve(@{
            @"durationMs": @(result.durationMs),
            @"isExact": @(result.isExact),
          });
        });
      } catch (const std::runtime_error &e) {
        [readHandle cleanup];
        if (tmpPathCleanup) {
          [[NSFileManager defaultManager] removeItemAtPath:tmpPathCleanup error:nil];
        }
        std::string msg = e.what();
        NSString *nsMsg = [NSString stringWithUTF8String:msg.c_str()];
        NSString *nsCode = @"PROBE_INTERNAL_ERROR";
        if (msg.find("PROBE_") == 0) {
          auto colonPos = msg.find(':');
          if (colonPos != std::string::npos) {
            nsCode = [NSString stringWithUTF8String:msg.substr(0, colonPos).c_str()];
          }
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(nsCode, nsMsg, nil);
        });
      } catch (...) {
        [readHandle cleanup];
        if (tmpPathCleanup) {
          [[NSFileManager defaultManager] removeItemAtPath:tmpPathCleanup error:nil];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(@"PROBE_INTERNAL_ERROR", @"Unknown error during duration probe", nil);
        });
      }
    }
  });
}

// ---- Container format probe (no PCM decode) ----
- (void)probeAudioFileContainer:(NSDictionary *)source
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  if (!source || [source count] == 0) {
    reject(kPAErrInvalidArgument, @"source is required", nil);
    return;
  }

  NSString *errCode = nil;
  NSString *errMsg = nil;
  FileIOReadHandle *readHandle = [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
  if (!readHandle) {
    reject(errCode ?: kPAErrFileNotFound, errMsg ?: @"Failed to resolve audio source", nil);
    return;
  }

  NSString *displayName = nil;
  if ([source[@"displayName"] isKindOfClass:[NSString class]]) {
    displayName = source[@"displayName"];
  }

  NSString *sourcePath = nil;
  NSString *tmpPath = nil;
  if (readHandle.isFilePath) {
    sourcePath = readHandle.filePath;
  } else {
    NSString *ext = @"";
    if (displayName.length > 0) {
      NSString *candidate = [displayName pathExtension];
      if (candidate.length > 0 && candidate.length <= 8) {
        ext = [NSString stringWithFormat:@".%@", candidate.lowercaseString];
      }
    }
    tmpPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
               [NSString stringWithFormat:@"fileio_probe_%@%@", [[NSUUID UUID] UUIDString], ext]];
    NSOutputStream *out = [NSOutputStream outputStreamToFileAtPath:tmpPath append:NO];
    [out open];
    [readHandle.stream open];
    uint8_t buf[65536];
    NSInteger bytesRead;
    while ((bytesRead = [readHandle.stream read:buf maxLength:sizeof(buf)]) > 0) {
      [out write:buf maxLength:bytesRead];
    }
    [out close];
    sourcePath = tmpPath;
  }

  NSString *pathHint = displayName.length > 0 ? displayName : sourcePath;
  NSString *probePath = readHandle.isFilePath ? sourcePath : pathHint;
  std::string path = [probePath UTF8String];
  NSString *tmpPathCleanup = tmpPath;

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    @autoreleasepool {
      try {
        auto result = sherpa::probeFileContainer(path.c_str(), -1);
        [readHandle cleanup];
        if (tmpPathCleanup) {
          [[NSFileManager defaultManager] removeItemAtPath:tmpPathCleanup error:nil];
        }

        dispatch_async(dispatch_get_main_queue(), ^{
          resolve(@{
            @"inputFormatName": [NSString stringWithUTF8String:result.inputFormatName.c_str()],
            @"codecName": [NSString stringWithUTF8String:result.codecName.c_str()],
          });
        });
      } catch (const std::runtime_error &e) {
        [readHandle cleanup];
        if (tmpPathCleanup) {
          [[NSFileManager defaultManager] removeItemAtPath:tmpPathCleanup error:nil];
        }
        std::string msg = e.what();
        NSString *nsMsg = [NSString stringWithUTF8String:msg.c_str()];
        NSString *nsCode = @"PROBE_INTERNAL_ERROR";
        if (msg.find("PROBE_") == 0) {
          auto colonPos = msg.find(':');
          if (colonPos != std::string::npos) {
            nsCode = [NSString stringWithUTF8String:msg.substr(0, colonPos).c_str()];
          }
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(nsCode, nsMsg, nil);
        });
      } catch (...) {
        [readHandle cleanup];
        if (tmpPathCleanup) {
          [[NSFileManager defaultManager] removeItemAtPath:tmpPathCleanup error:nil];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(@"PROBE_INTERNAL_ERROR", @"Unknown error during container probe", nil);
        });
      }
    }
  });
}

- (void)computeAudioVisualizationProfile:(NSDictionary *)input
                                 options:(NSDictionary *)options
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
  if (!input || ![input isKindOfClass:[NSDictionary class]]) {
    reject(@"VISUALIZATION_INVALID_INPUT", @"input object is required", nil);
    return;
  }

  if (!options || ![options isKindOfClass:[NSDictionary class]]) {
    reject(@"VISUALIZATION_INVALID_OPTIONS", @"options object is required", nil);
    return;
  }

  NSString *kind = input[@"kind"];
  if (![kind isKindOfClass:[NSString class]] || kind.length == 0) {
    reject(@"VISUALIZATION_INVALID_INPUT", @"input.kind is required", nil);
    return;
  }

  PaVisualizationOptions parsedOptions;
  NSString *optionsErrCode = nil;
  NSString *optionsErrMsg = nil;
  if (!pa_parseVisualizationOptions(options, parsedOptions, &optionsErrCode, &optionsErrMsg)) {
    reject(optionsErrCode ?: @"VISUALIZATION_INVALID_OPTIONS", optionsErrMsg ?: @"Invalid visualization options", nil);
    return;
  }

  NSDictionary *inputCopy = [input copy];
  NSString *kindCopy = [kind copy];
  __weak SherpaOnnx *weakSelf = self;

  dispatch_async(SherpaAudioDecodeQueue(), ^{
    @autoreleasepool {
      try {
        sherpa::AudioVisualizationProfile profile;

        if ([kindCopy isEqualToString:@"offline"]) {
          NSString *bufferId = inputCopy[@"bufferId"];
          if (![bufferId isKindOfClass:[NSString class]] || bufferId.length == 0) {
            throw std::runtime_error("VISUALIZATION_INVALID_INPUT: offline input requires bufferId");
          }

          std::shared_ptr<PaOfflineEntry> entry;
          {
            std::lock_guard<std::mutex> lock(g_pa_mutex);
            auto it = g_pa_offline.find([bufferId UTF8String]);
            if (it == g_pa_offline.end()) {
              throw std::runtime_error("AUDIO_BUFFER_NOT_FOUND: Offline buffer not found");
            }
            entry = it->second;
          }

          const float *samples = entry->floatPtr();
          int sampleCount = entry->numSamples();
          profile = pa_computeVisualizationFromSamples(
            samples,
            sampleCount,
            entry->sampleRate,
            parsedOptions,
            weakSelf
          );
        } else if ([kindCopy isEqualToString:@"live"]) {
          NSString *handle = inputCopy[@"handle"];
          if (![handle isKindOfClass:[NSString class]] || handle.length == 0) {
            throw std::runtime_error("VISUALIZATION_INVALID_INPUT: live input requires handle");
          }

          std::shared_ptr<PaLiveEntry> liveEntry;
          {
            std::lock_guard<std::mutex> lock(g_pa_mutex);
            auto it = g_pa_live.find([handle UTF8String]);
            if (it == g_pa_live.end()) {
              if (g_pa_invalidated_live_ids.find([handle UTF8String]) != g_pa_invalidated_live_ids.end()) {
                throw std::runtime_error("BUFFER_INVALIDATED: Live buffer is invalidated after transfer");
              }
              throw std::runtime_error("AUDIO_BUFFER_NOT_FOUND: Live buffer not found");
            }
            liveEntry = it->second;
          }

          if (liveEntry->state != PaLiveEntry::FINISHED) {
            throw std::runtime_error("AUDIO_INVALID_STATE: Live buffer must be finalized before visualization");
          }

          if (liveEntry->hasActiveSpool && !liveEntry->spoolPath.empty()) {
            profile = pa_computeVisualizationFromFile(
              liveEntry->spoolPath,
              parsedOptions,
              weakSelf);
          } else {
            auto snapshot = liveEntry->snapshotRing();
            profile = pa_computeVisualizationFromSamples(
              snapshot.empty() ? nullptr : snapshot.data(),
              (int)snapshot.size(),
              liveEntry->sampleRate,
              parsedOptions,
              weakSelf
            );
          }
        } else if ([kindCopy isEqualToString:@"file"]) {
          NSDictionary *source = inputCopy[@"source"];
          if (![source isKindOfClass:[NSDictionary class]] || source.count == 0) {
            throw std::runtime_error("VISUALIZATION_INVALID_INPUT: file input requires source");
          }

          NSString *errCode = nil;
          NSString *errMsg = nil;
          FileIOReadHandle *readHandle = nil;
          NSString *tmpPath = nil;

          try {
            readHandle = [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
            if (!readHandle) {
              std::string code = errCode ? [errCode UTF8String] : "AUDIO_FILE_NOT_FOUND";
              std::string message = errMsg ? [errMsg UTF8String] : "Failed to resolve audio source";
              throw std::runtime_error(code + ": " + message);
            }

            NSString *sourcePath = nil;
            if (readHandle.isFilePath) {
              sourcePath = readHandle.filePath;
            } else {
              tmpPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
                [NSString stringWithFormat:@"fileio_viz_%@", [[NSUUID UUID] UUIDString]]];
              NSOutputStream *out = [NSOutputStream outputStreamToFileAtPath:tmpPath append:NO];
              [out open];
              [readHandle.stream open];

              uint8_t buffer[65536];
              NSInteger bytesRead = 0;
              while ((bytesRead = [readHandle.stream read:buffer maxLength:sizeof(buffer)]) > 0) {
                [out write:buffer maxLength:bytesRead];
              }
              [out close];
              sourcePath = tmpPath;
            }

            std::string path = [sourcePath UTF8String];
            profile = pa_computeVisualizationFromFile(path, parsedOptions, weakSelf);
          } catch (...) {
            if (readHandle) {
              [readHandle cleanup];
            }
            if (tmpPath) {
              [[NSFileManager defaultManager] removeItemAtPath:tmpPath error:nil];
            }
            throw;
          }

          if (readHandle) {
            [readHandle cleanup];
          }
          if (tmpPath) {
            [[NSFileManager defaultManager] removeItemAtPath:tmpPath error:nil];
          }
        } else {
          throw std::runtime_error("VISUALIZATION_INVALID_INPUT: unsupported input kind");
        }

        NSDictionary *result = pa_visualizationProfileToDict(profile);
        dispatch_async(dispatch_get_main_queue(), ^{
          resolve(result);
        });
      } catch (const std::runtime_error &e) {
        std::string msg = e.what();
        NSString *nsMsg = [NSString stringWithUTF8String:msg.c_str()];
        NSString *nsCode = @"VISUALIZATION_INTERNAL_ERROR";

        if (
          msg.rfind("VISUALIZATION_", 0) == 0 ||
          msg.rfind("AUDIO_", 0) == 0 ||
          msg.rfind("BUFFER_", 0) == 0 ||
          msg.rfind("DECODE_", 0) == 0
        ) {
          auto colonPos = msg.find(':');
          std::string code = colonPos == std::string::npos ? msg : msg.substr(0, colonPos);
          nsCode = [NSString stringWithUTF8String:code.c_str()];
        }

        dispatch_async(dispatch_get_main_queue(), ^{
          reject(nsCode, nsMsg, nil);
        });
      } catch (...) {
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(@"VISUALIZATION_INTERNAL_ERROR", @"Unknown visualization error", nil);
        });
      }
    }
  });
}

- (void)saveAudioVisualizationProfile:(NSDictionary *)profile
                              persist:(NSDictionary *)persist
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  if (![profile isKindOfClass:[NSDictionary class]] ||
      ![persist isKindOfClass:[NSDictionary class]]) {
    reject(@"AUDIO_VISUALIZATION_INVALID_OPTIONS", @"profile and persist are required", nil);
    return;
  }

  NSDictionary *destination = persist[@"destination"];
  if (![destination isKindOfClass:[NSDictionary class]]) {
    reject(@"AUDIO_VISUALIZATION_INVALID_OPTIONS", @"persist.destination is required", nil);
    return;
  }

  BOOL overwrite = NO;
  if ([persist[@"overwrite"] isKindOfClass:[NSNumber class]]) {
    overwrite = [persist[@"overwrite"] boolValue];
  }

  BOOL includeFramesExplicit = persist[@"includeFrames"] != nil;
  BOOL includeFramesFlag = includeFramesExplicit
    ? [persist[@"includeFrames"] boolValue]
    : YES;

  dispatch_async(SherpaAudioDecodeQueue(), ^{
    @autoreleasepool {
      try {
        sherpa::AudioVisualizationProfile nativeProfile;
        nativeProfile.sampleRate = [profile[@"sampleRate"] respondsToSelector:@selector(intValue)]
          ? [profile[@"sampleRate"] intValue]
          : 0;
        nativeProfile.durationMs = [profile[@"durationMs"] respondsToSelector:@selector(longLongValue)]
          ? [profile[@"durationMs"] longLongValue]
          : 0;
        nativeProfile.barCount = [profile[@"barCount"] respondsToSelector:@selector(intValue)]
          ? [profile[@"barCount"] intValue]
          : 0;
        nativeProfile.frameCount = [profile[@"frameCount"] respondsToSelector:@selector(intValue)]
          ? [profile[@"frameCount"] intValue]
          : 0;
        nativeProfile.frameDurationMs = [profile[@"frameDurationMs"] respondsToSelector:@selector(doubleValue)]
          ? [profile[@"frameDurationMs"] doubleValue]
          : 0.0;

        if (nativeProfile.barCount <= 0) {
          throw std::runtime_error("AUDIO_VISUALIZATION_INVALID_PROFILE: barCount required");
        }

        NSArray *levels = profile[@"levels"];
        if (![levels isKindOfClass:[NSArray class]] || (int)levels.count < nativeProfile.barCount) {
          throw std::runtime_error("AUDIO_VISUALIZATION_INVALID_PROFILE: levels required");
        }
        nativeProfile.levels.resize(static_cast<size_t>(nativeProfile.barCount));
        for (int i = 0; i < nativeProfile.barCount; ++i) {
          double raw = [levels[i] respondsToSelector:@selector(doubleValue)]
            ? [levels[i] doubleValue]
            : 0.0;
          nativeProfile.levels[static_cast<size_t>(i)] =
            static_cast<float>(std::max(0.0, std::min(1.0, raw)));
        }

        const bool wantFrames = includeFramesFlag && nativeProfile.frameCount > 0;
        if (wantFrames) {
          NSArray *frames = profile[@"frames"];
          const size_t expected =
            static_cast<size_t>(nativeProfile.frameCount) *
            static_cast<size_t>(nativeProfile.barCount);
          if (![frames isKindOfClass:[NSArray class]] || frames.count < expected) {
            throw std::runtime_error(
              "AUDIO_VISUALIZATION_INVALID_PROFILE: frames required when includeFrames");
          }
          nativeProfile.frames.resize(expected);
          for (size_t i = 0; i < expected; ++i) {
            double raw = [frames[i] respondsToSelector:@selector(doubleValue)]
              ? [frames[i] doubleValue]
              : 0.0;
            nativeProfile.frames[i] =
              static_cast<float>(std::max(0.0, std::min(1.0, raw)));
          }
        } else {
          nativeProfile.frameCount = 0;
          nativeProfile.frameDurationMs = 0.0;
          nativeProfile.frames.clear();
        }

        sherpa::AudioVisualizationSidecarEncodeOptions encodeOptions;
        encodeOptions.includeFrames = wantFrames;
        std::string encodeError;
        auto bytes = sherpa::encodeAudioVisualizationSidecar(
          nativeProfile, encodeOptions, &encodeError);
        if (bytes.empty()) {
          throw std::runtime_error(
            encodeError.empty()
              ? "AUDIO_VISUALIZATION_SIDECAR_ENCODE_FAILED"
              : encodeError);
        }

        NSString *errCode = nil, *errMsg = nil;
        FileIOWriteHandle *wh = [FileIOResolver resolveDestination:destination
                                                         overwrite:overwrite
                                           createParentDirectories:NO
                                                             error:&errCode
                                                           message:&errMsg];
        if (!wh) {
          dispatch_async(dispatch_get_main_queue(), ^{
            reject(errCode ?: @"FILEIO_RESOLVE_ERROR", errMsg ?: @"Failed to resolve destination", nil);
          });
          return;
        }

        NSData *data = [NSData dataWithBytes:bytes.data() length:bytes.size()];
        if (wh.isFilePath) {
          NSError *writeErr = nil;
          if (![data writeToFile:wh.filePath options:NSDataWritingAtomic error:&writeErr]) {
            [wh cleanup];
            dispatch_async(dispatch_get_main_queue(), ^{
              reject(@"FILEIO_WRITE_ERROR",
                     writeErr.localizedDescription ?: @"Write failed",
                     writeErr);
            });
            return;
          }
        } else {
          [wh cleanup];
          dispatch_async(dispatch_get_main_queue(), ^{
            reject(@"FILEIO_UNSUPPORTED_ON_PLATFORM",
                   @"Non-path FileDestination is not supported for visualization sidecars on iOS",
                   nil);
          });
          return;
        }

        NSString *outputPath = wh.resultPath ?: wh.filePath;
        [wh cleanup];

        NSDictionary *result = @{
          @"format": @"sherpa_viz_v1",
          @"kind": @"spectrum_bars",
          @"barCount": @(nativeProfile.barCount),
          @"durationMs": @(nativeProfile.durationMs),
          @"sampleRate": @(nativeProfile.sampleRate),
          @"hasFrames": @(wantFrames),
          @"output": @{
            @"outputKind": @"fs",
            @"outputPath": outputPath ?: @"",
          },
        };
        dispatch_async(dispatch_get_main_queue(), ^{
          resolve(result);
        });
      } catch (const std::runtime_error &e) {
        std::string msg = e.what();
        NSString *nsMsg = [NSString stringWithUTF8String:msg.c_str()];
        NSString *nsCode = @"VISUALIZATION_INTERNAL_ERROR";
        if (msg.rfind("AUDIO_VISUALIZATION_", 0) == 0 || msg.rfind("FILEIO_", 0) == 0) {
          auto colonPos = msg.find(':');
          std::string code = colonPos == std::string::npos ? msg : msg.substr(0, colonPos);
          nsCode = [NSString stringWithUTF8String:code.c_str()];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(nsCode, nsMsg, nil);
        });
      } catch (...) {
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(@"VISUALIZATION_INTERNAL_ERROR", @"Unknown sidecar save error", nil);
        });
      }
    }
  });
}

- (void)loadAudioVisualizationProfile:(NSDictionary *)source
                              options:(NSDictionary *)options
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  if (![source isKindOfClass:[NSDictionary class]]) {
    reject(@"AUDIO_VISUALIZATION_INVALID_INPUT", @"source is required", nil);
    return;
  }

  NSDictionary *resolvedSource = source;
  if ([source[@"kind"] isKindOfClass:[NSString class]] &&
      [source[@"kind"] isEqualToString:@"file"] &&
      [source[@"source"] isKindOfClass:[NSDictionary class]]) {
    resolvedSource = source[@"source"];
  }

  BOOL strict = YES;
  if ([options isKindOfClass:[NSDictionary class]] &&
      [options[@"strict"] isKindOfClass:[NSNumber class]]) {
    strict = [options[@"strict"] boolValue];
  }

  dispatch_async(SherpaAudioDecodeQueue(), ^{
    @autoreleasepool {
      NSString *errCode = nil, *errMsg = nil;
      FileIOReadHandle *rh = [FileIOResolver resolveSource:resolvedSource
                                                     error:&errCode
                                                   message:&errMsg];
      if (!rh) {
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(errCode ?: @"FILEIO_RESOLVE_ERROR", errMsg ?: @"Failed to resolve source", nil);
        });
        return;
      }

      NSData *data = nil;
      @try {
        if (rh.isFilePath) {
          data = [NSData dataWithContentsOfFile:rh.filePath];
        } else if (rh.stream != nil) {
          [rh.stream open];
          NSMutableData *buffer = [NSMutableData data];
          uint8_t chunk[65536];
          NSInteger bytesRead = 0;
          while ((bytesRead = [rh.stream read:chunk maxLength:sizeof(chunk)]) > 0) {
            [buffer appendBytes:chunk length:bytesRead];
          }
          data = buffer;
        }
      } @finally {
        [rh cleanup];
      }

      if (data == nil || data.length == 0) {
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(@"AUDIO_VISUALIZATION_SIDECAR_INVALID", @"empty payload", nil);
        });
        return;
      }

      try {
        sherpa::AudioVisualizationProfile profile;
        std::string decodeError;
        if (!sherpa::decodeAudioVisualizationSidecar(
              static_cast<const uint8_t *>(data.bytes),
              static_cast<size_t>(data.length),
              strict,
              &profile,
              &decodeError)) {
          throw std::runtime_error(
            decodeError.empty()
              ? "AUDIO_VISUALIZATION_SIDECAR_INVALID"
              : decodeError);
        }

        NSDictionary *result = pa_visualizationProfileToDict(profile);
        dispatch_async(dispatch_get_main_queue(), ^{
          resolve(result);
        });
      } catch (const std::runtime_error &e) {
        std::string msg = e.what();
        NSString *nsMsg = [NSString stringWithUTF8String:msg.c_str()];
        NSString *nsCode = @"VISUALIZATION_INTERNAL_ERROR";
        if (msg.rfind("AUDIO_VISUALIZATION_", 0) == 0 || msg.rfind("FILEIO_", 0) == 0) {
          auto colonPos = msg.find(':');
          std::string code = colonPos == std::string::npos ? msg : msg.substr(0, colonPos);
          nsCode = [NSString stringWithUTF8String:code.c_str()];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(nsCode, nsMsg, nil);
        });
      } catch (...) {
        dispatch_async(dispatch_get_main_queue(), ^{
          reject(@"VISUALIZATION_INTERNAL_ERROR", @"Unknown sidecar load error", nil);
        });
      }
    }
  });
}

// ---- Offline: from live ----
- (void)createOfflineAudioBufferFromLive:(NSString *)liveBufferId
                                 options:(NSDictionary *)options
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
        if (g_pa_invalidated_live_ids.find(liveId) != g_pa_invalidated_live_ids.end()) {
          reject(kPAErrBufferInvalidated, @"Live buffer is invalidated after transfer", nil);
        } else {
          reject(kPAErrBufferNotFound, @"Live buffer not found", nil);
        }
        return;
      }
      live = it->second;
    }

    NSString *modeObj = options[@"mode"];
    std::string modeStr = (modeObj != nil && [modeObj isKindOfClass:[NSString class]] && modeObj.length > 0)
      ? [modeObj UTF8String]
      : "fullIfSpooled";
    if (modeStr != "fullIfSpooled" && modeStr != "windowSnapshot") {
      reject(kPAErrInvalidArgument, @"Unknown mode. Use 'fullIfSpooled' or 'windowSnapshot'.", nil);
      return;
    }

    int effectiveTarget = pa_resolveEffectiveTargetSampleRateHz(options, live->sampleRate);

    // Same-SR fullIfSpooled: transfer/mmap-adopt (no WAV→.f32 double copy); invalidates live.
    // Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (C #9).
    if (modeStr == "fullIfSpooled" && effectiveTarget == live->sampleRate) {
      std::string offlineId, errCode, errMsg;
      if (!pa_transfer_offline_from_live(liveId, /*fullIfSpooled=*/true, &offlineId, &errCode,
                                         &errMsg)) {
        NSString *nsCode = errCode.empty() ? kPAErrInternalError
                                           : [NSString stringWithUTF8String:errCode.c_str()];
        NSString *nsMsg = errMsg.empty() ? @"Failed to create offline buffer from live"
                                         : [NSString stringWithUTF8String:errMsg.c_str()];
        reject(nsCode, nsMsg, nil);
        return;
      }
      auto transferred = pa_get_offline_entry(offlineId);
      if (!transferred) {
        reject(kPAErrInternalError, @"Offline missing after transfer", nil);
        return;
      }
      resolve(transferred->toDict());
      return;
    }

    std::string bufferId = pa_generate_id("off");
    std::shared_ptr<PaOfflineEntry> entry;

    if (effectiveTarget == live->sampleRate) {
      // windowSnapshot — keep live registered.
      auto snapshot = live->snapshotRing();
      entry = pa_create_entry_with_threshold(bufferId, live->sampleRate, live->channelCount, snapshot);
    } else {
      if (live->channelCount != 1) {
        reject(kPAErrInvalidArgument, @"Resampling live→offline requires mono (channelCount=1)", nil);
        return;
      }
      std::vector<float> pcm;
      if (modeStr == "fullIfSpooled" && live->hasActiveSpool && live->state == PaLiveEntry::FINISHED &&
          !live->spoolPath.empty()) {
        pcm = pa_read_f32_wav_spool_samples(live->spoolPath);
      }
      if (pcm.empty()) {
        pcm = live->snapshotRing();
      }
      auto resampled = pa_resampleLinear(pcm.data(), pcm.size(), live->sampleRate, effectiveTarget);
      entry = pa_create_entry_with_threshold(bufferId, effectiveTarget, 1, resampled);
    }

    if (!entry) {
      reject(kPAErrInternalError, @"Failed to create offline buffer from live", nil);
      return;
    }

    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      g_pa_offline[bufferId] = entry;
    }
    resolve(entry->toDict());
  } @catch (NSException *e) {
    if ([e.name isEqualToString:@"InvalidArgument"]) {
      reject(kPAErrInvalidArgument, e.reason, nil);
    } else {
      reject(kPAErrInternalError, e.reason, nil);
    }
  }
}

// ---- Offline: from offline ----
- (void)createOfflineAudioBufferFromOffline:(NSString *)offlineBufferId
                                    options:(NSDictionary *)options
                                    resolve:(RCTPromiseResolveBlock)resolve
                                     reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string sourceId = [offlineBufferId UTF8String];
    std::shared_ptr<PaOfflineEntry> source;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_offline.find(sourceId);
      if (it == g_pa_offline.end()) {
        reject(kPAErrBufferNotFound, @"Offline buffer not found", nil);
        return;
      }
      source = it->second;
    }

    int effectiveTarget = pa_resolveEffectiveTargetSampleRateHz(options, source->sampleRate);
    if (effectiveTarget != source->sampleRate && source->channelCount != 1) {
      reject(kPAErrInvalidArgument, @"Resampling offline→offline requires mono (channelCount=1)", nil);
      return;
    }

    // Same-SR clone = one PCM copy via floatPtr (not readAllSamples + recreate).
    // Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (C #16).
    if (effectiveTarget == source->sampleRate) {
      std::string offlineId, errCode, errMsg;
      if (!pa_clone_offline(sourceId, &offlineId, &errCode, &errMsg)) {
        NSString *nsCode = errCode.empty() ? kPAErrInternalError
                                           : [NSString stringWithUTF8String:errCode.c_str()];
        NSString *nsMsg = errMsg.empty() ? @"Failed to create offline buffer from offline"
                                         : [NSString stringWithUTF8String:errMsg.c_str()];
        reject(nsCode, nsMsg, nil);
        return;
      }
      auto cloned = pa_get_offline_entry(offlineId);
      if (!cloned) {
        reject(kPAErrInternalError, @"Offline missing after clone", nil);
        return;
      }
      resolve(cloned->toDict());
      return;
    }

    const float *ptr = source->floatPtr();
    const int n = source->numSamples();
    if (n < 0 || (n > 0 && !ptr)) {
      reject(kPAErrInternalError, @"Offline floatPtr unavailable", nil);
      return;
    }
    auto output = pa_resampleLinear(ptr, static_cast<size_t>(n), source->sampleRate, effectiveTarget);

    std::string bufferId = pa_generate_id("off");
    auto entry = pa_create_entry_with_threshold(
      bufferId,
      effectiveTarget,
      source->channelCount,
      output
    );
    if (!entry) {
      reject(kPAErrInternalError, @"Failed to create offline buffer from offline", nil);
      return;
    }

    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      g_pa_offline[bufferId] = entry;
    }
    resolve(entry->toDict());
  } @catch (NSException *e) {
    if ([e.name isEqualToString:@"InvalidArgument"]) {
      reject(kPAErrInvalidArgument, e.reason, nil);
    } else {
      reject(kPAErrInternalError, e.reason, nil);
    }
  }
}

- (void)transferOfflineAudioBufferFromLive:(NSString *)liveBufferId
                                      mode:(NSString *)mode
                                   resolve:(RCTPromiseResolveBlock)resolve
                                    reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string liveId = [liveBufferId UTF8String];
    std::string modeStr = mode ? [mode UTF8String] : "fullIfSpooled";
    if (modeStr != "fullIfSpooled") {
      reject(kPAErrInvalidArgument, @"Unsupported transfer mode. Use 'fullIfSpooled'.", nil);
      return;
    }

    std::shared_ptr<PaLiveEntry> live;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_live.find(liveId);
      if (it == g_pa_live.end()) {
        if (g_pa_invalidated_live_ids.find(liveId) != g_pa_invalidated_live_ids.end()) {
          reject(kPAErrBufferInvalidated, @"Live buffer is invalidated after transfer", nil);
        } else {
          reject(kPAErrBufferNotFound, @"Live buffer not found", nil);
        }
        return;
      }
      live = it->second;
    }

    if (live->state != PaLiveEntry::FINISHED) {
      reject(kPAErrTransferInvalidState, @"Live buffer must be finalized before transfer", nil);
      return;
    }

    if (!live->hasActiveSpool || live->spoolPath.empty()) {
      reject(kPAErrTransferSpoolUnavailable, @"Live buffer has no spool file to transfer", nil);
      return;
    }

    if (live->activeCursorCount() > 0) {
      reject(kPAErrTransferCursorsActive, @"Live buffer has active cursors and cannot be transferred", nil);
      return;
    }

    std::string spoolPath = live->spoolPath;
    std::string bufferId = pa_generate_id("off");
    auto entry = pa_create_offline_from_transferred_wav_spool(
      bufferId,
      spoolPath,
      live->sampleRate,
      live->channelCount
    );
    if (!entry) {
      reject(kPAErrInternalError, @"Failed to transfer live spool to offline buffer", nil);
      return;
    }

    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_live.find(liveId);
      if (it == g_pa_live.end()) {
        if (g_pa_invalidated_live_ids.find(liveId) != g_pa_invalidated_live_ids.end()) {
          reject(kPAErrBufferInvalidated, @"Live buffer is invalidated after transfer", nil);
        } else {
          reject(kPAErrBufferNotFound, @"Live buffer not found", nil);
        }
        return;
      }
      it->second->detachSpoolForTransfer();
      g_pa_live.erase(it);
      g_pa_invalidated_live_ids.insert(liveId);
      g_pa_offline[bufferId] = entry;
    }

    resolve(entry->toDict());
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

- (void)populateOfflineAudioBufferIfEmpty:(NSString *)targetBufferId
                             sourceBufferId:(NSString *)sourceBufferId
                                    options:(NSDictionary *)options
                                    resolve:(RCTPromiseResolveBlock)resolve
                                     reject:(RCTPromiseRejectBlock)reject
{
  (void)options;
  @try {
    if (targetBufferId == nil || [targetBufferId length] == 0) {
      reject(kPAErrInvalidArgument, @"targetBufferId is required", nil);
      return;
    }
    if (sourceBufferId == nil || [sourceBufferId length] == 0) {
      reject(kPAErrInvalidArgument, @"sourceBufferId is required", nil);
      return;
    }

    std::string targetId = [targetBufferId UTF8String] ?: "";
    std::string sourceId = [sourceBufferId UTF8String] ?: "";
    std::string errCode;
    std::string errMsg;
    if (!pa_populate_offline_from_source_if_empty(targetId, sourceId, &errCode, &errMsg)) {
      NSString *message = [NSString stringWithUTF8String:errMsg.c_str()] ?: @"Failed to populate offline audio buffer";
      if (errCode == "AUDIO_BUFFER_NOT_FOUND") {
        reject(kPAErrBufferNotFound, message, nil);
        return;
      }
      if (errCode == "AUDIO_INVALID_STATE") {
        reject(kPAErrInvalidState, message, nil);
        return;
      }
      if (errCode == "AUDIO_INVALID_ARGUMENT") {
        reject(kPAErrInvalidArgument, message, nil);
        return;
      }
      reject(kPAErrInternalError, message, nil);
      return;
    }

    resolve(nil);
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Live: create ----
- (void)createEmptyLiveAudioBuffer:(JS::NativeSherpaOnnx::SpecCreateEmptyLiveAudioBufferOptions &)options
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  @try {
    int sr = (int)options.sampleRate();
    if (sr <= 0) { sr = 16000; }
    int ch = options.channelCount().has_value() ? (int)options.channelCount().value() : 1;
    double ringSec = options.ringSeconds().has_value() ? options.ringSeconds().value() : 60.0;
    if (ringSec <= 0) { reject(kPAErrInvalidArgument, @"ringSeconds must be > 0", nil); return; }

    // Parse retention options
    NSString *retentionModeNS = options.retentionMode();
    std::string retentionMode = retentionModeNS ? [retentionModeNS UTF8String] : "auto";
    NSString *retentionPathNS = options.retentionPath();
    std::string retentionPath = retentionPathNS ? [retentionPathNS UTF8String] : "";
    double retentionSec = options.retentionSeconds().has_value() ? options.retentionSeconds().value() : 0.0;

    std::string spoolPath;
    bool isTemporary = false;

    if (retentionMode == "none") {
      // No spool
      spoolPath = "";
    } else if (retentionMode == "auto" || retentionMode == "session" || retentionMode == "maxSeconds") {
      if (retentionMode == "maxSeconds" && retentionSec <= 0) {
        reject(kPAErrInvalidArgument, @"retention.mode 'maxSeconds' requires seconds > 0", nil);
        return;
      }
      // NOTE: Native trim enforcement for auto/maxSeconds is not implemented yet.
      // These modes currently keep session-long spool data.
      if (!retentionPath.empty()) {
        spoolPath = retentionPath;
      } else {
        NSString *tmpDir = NSTemporaryDirectory();
        NSString *tmpFile = [NSString stringWithFormat:@"live_spool_%llu.wav", (unsigned long long)(CFAbsoluteTimeGetCurrent() * 1000.0)];
        spoolPath = [[tmpDir stringByAppendingPathComponent:tmpFile] UTF8String];
      }
      isTemporary = (retentionMode != "path");
    } else if (retentionMode == "path") {
      spoolPath = retentionPath;
      NSString *retentionTrimNS = options.retentionTrim();
      std::string retentionTrim = retentionTrimNS ? [retentionTrimNS UTF8String] : "session";
      if (retentionTrim == "maxSeconds") {
        double trimMaxSec = options.retentionTrimMaxSeconds().has_value() ? options.retentionTrimMaxSeconds().value() : 0.0;
        if (trimMaxSec <= 0) {
          reject(kPAErrInvalidArgument, @"retention.trim.maxSeconds must be > 0", nil);
          return;
        }
      } else if (retentionTrim != "auto" && retentionTrim != "session") {
        reject(kPAErrInvalidArgument, @"retention.trim must be 'auto', 'session', or {maxSeconds}", nil);
        return;
      }
    } else {
      reject(kPAErrInvalidArgument, [NSString stringWithFormat:@"Unknown retentionMode '%@'", retentionModeNS ?: @"(null)"], nil);
      return;
    }

    bool emitAppendedEvents = options.emitAppendedEvents().has_value() ? options.emitAppendedEvents().value() : false;
    int appendEventMinIntervalMs = options.appendEventMinIntervalMs().has_value()
      ? std::max(0, (int)options.appendEventMinIntervalMs().value())
      : 0;

    std::string bufferId = pa_generate_id("live");
    NSString *liveBufferId = [NSString stringWithUTF8String:bufferId.c_str()];
    __weak SherpaOnnx *weakSelf = self;

    auto onFramesAppended = [weakSelf, liveBufferId, sr](
      const PaLiveFramesAppendedPayload &event
    ) {
      SherpaOnnx *module = weakSelf;
      if (!module) return;

      NSMutableDictionary *payload = [NSMutableDictionary dictionary];
      payload[@"liveBufferId"] = liveBufferId ?: @"";
      payload[@"appendKind"] = [NSString stringWithUTF8String:pa_live_append_kind_wire(event.appendKind)];
      if (event.appendKind == PaLiveAppendKind::Ingress) {
        payload[@"ingressSource"] = [NSString stringWithUTF8String:pa_live_ingress_wire(event.ingressSource)];
      } else if (event.appendKind == PaLiveAppendKind::Pipeline) {
        payload[@"pipelineWriter"] = [NSString stringWithUTF8String:pa_live_pipeline_writer_wire(event.pipelineWriter)];
      }
      payload[@"sampleRate"] = @(sr);
      payload[@"frameCount"] = @(event.frameCount);
      payload[@"totalSamplesWritten"] = @((double)event.totalSamplesWritten);

      dispatch_async(dispatch_get_main_queue(), ^{
        [module sendEventWithName:@"pipelineLiveAudioChunk" body:payload];
      });
    };

    auto entry = std::make_shared<PaLiveEntry>(
      bufferId,
      sr,
      ch,
      ringSec,
      spoolPath,
      emitAppendedEvents,
      appendEventMinIntervalMs,
      onFramesAppended
    );
    if (isTemporary) {
      entry->isTemporarySpool = true;
    }
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      g_pa_live[bufferId] = entry;
    }
    resolve(entry->toDict());
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
      if (lit == g_pa_live.end()) {
        if (g_pa_invalidated_live_ids.find(liveId) != g_pa_invalidated_live_ids.end()) {
          reject(kPAErrBufferInvalidated, @"Live buffer is invalidated after transfer", nil);
        } else {
          reject(kPAErrBufferNotFound, @"Live buffer not found", nil);
        }
        return;
      }
      live = lit->second;
      auto oit = g_pa_offline.find(offId);
      if (oit == g_pa_offline.end()) { reject(kPAErrBufferNotFound, @"Offline buffer not found", nil); return; }
      offline = oit->second;
    }
    if (live->state != PaLiveEntry::RECORDING) {
      reject(kPAErrAlreadyFinalized, @"Live buffer is finalized", nil);
      return;
    }
    // Chunked floatPtr append (no full materialize).
    // Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (C #16).
    std::string errCode, errMsg;
    if (!pa_append_offline_to_live(liveId, offId, &errCode, &errMsg)) {
      NSString *nsCode = errCode.empty() ? kPAErrInternalError
                                         : [NSString stringWithUTF8String:errCode.c_str()];
      NSString *nsMsg = errMsg.empty() ? @"Failed to append offline to live"
                                       : [NSString stringWithUTF8String:errMsg.c_str()];
      reject(nsCode, nsMsg, nil);
      return;
    }
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
      if (it == g_pa_live.end()) {
        if (g_pa_invalidated_live_ids.find(liveId) != g_pa_invalidated_live_ids.end()) {
          reject(kPAErrBufferInvalidated, @"Live buffer is invalidated after transfer", nil);
        } else {
          reject(kPAErrBufferNotFound, @"Live buffer not found", nil);
        }
        return;
      }
      live = it->second;
    }
    live->finalize_();
    resolve(nil);
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Audio save helpers ----

static bool pa_validateSaveParams(const std::string &fmt, int rate,
                                   RCTPromiseRejectBlock reject) {
  static const std::set<std::string> supportedFormats = {"wav","mp3","flac","aac","m4a","opus","webm","mkv","ogg"};
  if (supportedFormats.find(fmt) == supportedFormats.end()) {
    reject(@"AUDIO_SAVE_UNSUPPORTED_FORMAT",
           [NSString stringWithFormat:@"Unsupported format: %s", fmt.c_str()], nil);
    return false;
  }
  if (rate < 0) {
    reject(@"AUDIO_SAVE_INVALID_SAMPLE_RATE", @"outputSampleRateHz must be >= 0", nil);
    return false;
  }
  if (fmt == "mp3" && rate != 0 && rate != 32000 && rate != 44100 && rate != 48000) {
    reject(@"AUDIO_SAVE_INVALID_SAMPLE_RATE",
           [NSString stringWithFormat:@"MP3 sample rate must be 32000, 44100, 48000, or 0. Got: %d", rate], nil);
    return false;
  }
  if ((fmt == "opus" || fmt == "ogg" || fmt == "webm" || fmt == "mkv") &&
      rate != 0 && rate != 8000 && rate != 12000 && rate != 16000 && rate != 24000 && rate != 48000) {
    reject(@"AUDIO_SAVE_INVALID_SAMPLE_RATE",
           [NSString stringWithFormat:@"Opus sample rate must be 8000, 12000, 16000, 24000, 48000, or 0. Got: %d", rate], nil);
    return false;
  }
  return true;
}

static void pa_cleanupOutputFile(NSString *path) {
  if (path) {
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
  }
}

static std::string pa_encodeViaPcm(
    const float *samples, int numSamples, int sampleRate, int channelCount,
    const char *outputPath, const char *format, int outputSampleRateHz,
    int bitrate, int quality, std::atomic<bool> &cancelFlag) {
  sherpa::AudioEncodeConfig config{};
  config.outputPath = outputPath;
  config.formatHint = format;
  config.inputSampleRate = sampleRate;
  config.inputChannelCount = channelCount;
  config.outputSampleRateHz = outputSampleRateHz;
  config.bitrate = bitrate;
  config.quality = quality;

  std::string errorOut;
  int totalFrames = numSamples / channelCount;
  auto session = sherpa::AudioEncodeSession::create(config, totalFrames, nullptr, cancelFlag, errorOut);
  if (!session) return errorOut;

  const int chunkFrames = 4096;
  int offset = 0;
  while (offset < totalFrames) {
    int chunk = std::min(chunkFrames, totalFrames - offset);
    std::string err = session->feedChunk(samples + offset * channelCount, chunk);
    if (!err.empty()) return err;
    offset += chunk;
  }
  return session->finish();
}

static std::string pa_encodeViaDecodeFile(
    const char *inputPath, const char *outputPath, const char *format,
    int outputSampleRateHz, int bitrate, int quality,
    std::atomic<bool> &cancelFlag) {
  // Batch decode the file first
  sherpa::AudioDecodeConfig decConfig{};
  decConfig.targetSampleRate = 0; // keep source rate
  decConfig.forceMono = true;
  decConfig.chunkSize = 8192;

  std::vector<float> allSamples;
  auto onChunk = [&allSamples](const float *samples, int frameCount) {
    allSamples.insert(allSamples.end(), samples, samples + frameCount);
  };

  sherpa::AudioDecodeResult decResult;
  try {
    decResult = sherpa::decodeFile(inputPath, decConfig, onChunk, nullptr, nullptr, cancelFlag);
  } catch (const std::exception &e) {
    return std::string("AUDIO_SAVE_SOURCE_NOT_FOUND: ") + e.what();
  }

  if (allSamples.empty()) {
    return "AUDIO_SAVE_SOURCE_NOT_FOUND: Decoded file is empty";
  }

  int srcRate = decResult.sourceSampleRate > 0 ? decResult.sourceSampleRate : 16000;
  return pa_encodeViaPcm(allSamples.data(), (int)allSamples.size(), srcRate, 1,
                         outputPath, format, outputSampleRateHz, bitrate, quality, cancelFlag);
}

// ---- Save audio buffer to file ----
- (void)saveAudioBufferToFile:(NSString *)bufferId
                  destination:(NSDictionary *)destination
                       format:(NSString *)format
           outputSampleRateHz:(double)outputSampleRateHz
                      bitrate:(double)bitrate
                      quality:(double)quality
                  operationId:(NSString *)operationId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  int rate = (int)outputSampleRateHz;
  std::string fmt = [[format lowercaseString] UTF8String];

  if (!pa_validateSaveParams(fmt, rate, reject)) return;

  // Register cancel flag
  auto cancelFlag = std::make_shared<std::atomic<bool>>(false);
  std::string opId = [operationId UTF8String];
  {
    std::lock_guard<std::mutex> lock(g_pa_saveCancelMutex);
    g_pa_saveCancelFlags[opId] = cancelFlag;
  }

  // Resolve destination
  NSString *errCode = nil, *errMsg = nil;
  FileIOWriteHandle *wh = [FileIOResolver resolveDestination:destination overwrite:YES
                                     createParentDirectories:NO error:&errCode message:&errMsg];
  if (!wh) {
    {
      std::lock_guard<std::mutex> lock(g_pa_saveCancelMutex);
      g_pa_saveCancelFlags.erase(opId);
    }
    reject(errCode, errMsg, nil);
    return;
  }

  NSString *outputPath = wh.filePath;
  NSString *outputKind = @"fs";
  NSString *resultPath = wh.resultPath;

  std::string bid = [bufferId UTF8String];
  std::string outputPathStr = [outputPath UTF8String];
  std::string err;

  std::lock_guard<std::mutex> lock(g_pa_mutex);

  // Offline buffer?
  if (bid.rfind("off_", 0) == 0) {
    auto it = g_pa_offline.find(bid);
    if (it == g_pa_offline.end()) {
      [wh cleanup]; pa_cleanupOutputFile(outputPath);
      { std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex); g_pa_saveCancelFlags.erase(opId); }
      reject(@"AUDIO_SAVE_SOURCE_NOT_FOUND", @"Offline buffer not found", nil); return;
    }
    auto &entry = it->second;
    if (entry->numSamples() == 0) {
      [wh cleanup]; pa_cleanupOutputFile(outputPath);
      { std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex); g_pa_saveCancelFlags.erase(opId); }
      reject(@"AUDIO_SAVE_BUFFER_EMPTY", @"Buffer is empty", nil); return;
    }

    {
      const float *ptr = entry->floatPtr();
      int n = entry->numSamples();
      err = pa_encodeViaPcm(ptr, n,
                             entry->sampleRate, entry->channelCount,
                             outputPathStr.c_str(), fmt.c_str(), rate,
                             (int)bitrate, (int)quality, *cancelFlag);
    }
  }
  // Live buffer?
  else if (bid.rfind("live_", 0) == 0) {
    auto it = g_pa_live.find(bid);
    if (it == g_pa_live.end()) {
      [wh cleanup]; pa_cleanupOutputFile(outputPath);
      { std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex); g_pa_saveCancelFlags.erase(opId); }
      if (g_pa_invalidated_live_ids.find(bid) != g_pa_invalidated_live_ids.end()) {
        reject(kPAErrBufferInvalidated, @"Live buffer is invalidated after transfer", nil);
      } else {
        reject(@"AUDIO_SAVE_SOURCE_NOT_FOUND", @"Live buffer not found", nil);
      }
      return;
    }
    auto &entry = it->second;
    if (entry->state != PaLiveEntry::FINISHED) {
      [wh cleanup]; pa_cleanupOutputFile(outputPath);
      { std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex); g_pa_saveCancelFlags.erase(opId); }
      reject(@"AUDIO_SAVE_BUFFER_NOT_FINALIZED", @"Live buffer must be finalized before saving", nil); return;
    }
    if (entry->totalSamplesWritten == 0) {
      [wh cleanup]; pa_cleanupOutputFile(outputPath);
      { std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex); g_pa_saveCancelFlags.erase(opId); }
      reject(@"AUDIO_SAVE_BUFFER_EMPTY", @"Buffer is empty", nil); return;
    }

    if (entry->hasActiveSpool) {
      err = pa_encodeViaDecodeFile(entry->spoolPath.c_str(), outputPathStr.c_str(), fmt.c_str(),
                                    rate, (int)bitrate, (int)quality, *cancelFlag);
    } else {
      auto snapshot = entry->snapshotRing();
      err = pa_encodeViaPcm(snapshot.data(), (int)snapshot.size(), entry->sampleRate, 1,
                             outputPathStr.c_str(), fmt.c_str(), rate,
                             (int)bitrate, (int)quality, *cancelFlag);
    }
  }
  else {
    [wh cleanup]; pa_cleanupOutputFile(outputPath);
    { std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex); g_pa_saveCancelFlags.erase(opId); }
    reject(@"AUDIO_SAVE_SOURCE_NOT_FOUND", @"Invalid buffer ID prefix: expected off_ or live_", nil);
    return;
  }

  {
    std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex);
    g_pa_saveCancelFlags.erase(opId);
  }

  if (!err.empty()) {
    [wh cleanup]; pa_cleanupOutputFile(outputPath);
    NSString *code = @"AUDIO_SAVE_ENCODE_ERROR";
    NSString *nsErr = [NSString stringWithUTF8String:err.c_str()];
    if ([nsErr containsString:@"CANCELLED"]) code = @"AUDIO_SAVE_CANCELLED";
    reject(code, nsErr, nil);
    return;
  }

  [wh cleanup];
  resolve(@{ @"outputKind": outputKind, @"outputPath": resultPath });
}

// ---- Save file as audio file (file-to-file, no buffer registry) ----
- (void)saveFileAsAudioFile:(NSDictionary *)source
                destination:(NSDictionary *)destination
                     format:(NSString *)format
         outputSampleRateHz:(double)outputSampleRateHz
                    bitrate:(double)bitrate
                    quality:(double)quality
                operationId:(NSString *)operationId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  int rate = (int)outputSampleRateHz;
  std::string fmt = [[format lowercaseString] UTF8String];

  if (!pa_validateSaveParams(fmt, rate, reject)) return;

  // Register cancel flag
  auto cancelFlag = std::make_shared<std::atomic<bool>>(false);
  std::string opId = [operationId UTF8String];
  {
    std::lock_guard<std::mutex> lock(g_pa_saveCancelMutex);
    g_pa_saveCancelFlags[opId] = cancelFlag;
  }

  // Resolve source
  NSString *srcErrCode = nil, *srcErrMsg = nil;
  FileIOReadHandle *rh = [FileIOResolver resolveSource:source error:&srcErrCode message:&srcErrMsg];
  if (!rh) {
    {
      std::lock_guard<std::mutex> lock(g_pa_saveCancelMutex);
      g_pa_saveCancelFlags.erase(opId);
    }
    reject(srcErrCode, srcErrMsg, nil);
    return;
  }
  NSString *inputPath = rh.filePath;

  // Resolve destination
  NSString *dstErrCode = nil, *dstErrMsg = nil;
  FileIOWriteHandle *wh = [FileIOResolver resolveDestination:destination overwrite:YES
                                     createParentDirectories:NO error:&dstErrCode message:&dstErrMsg];
  if (!wh) {
    [rh cleanup];
    {
      std::lock_guard<std::mutex> lock(g_pa_saveCancelMutex);
      g_pa_saveCancelFlags.erase(opId);
    }
    reject(dstErrCode, dstErrMsg, nil);
    return;
  }

  NSString *outputPath = wh.filePath;
  NSString *outputKind = @"fs";
  NSString *resultPath = wh.resultPath;

  std::string inputPathStr = [inputPath UTF8String];
  std::string outputPathStr = [outputPath UTF8String];

  std::string err = pa_encodeViaDecodeFile(inputPathStr.c_str(), outputPathStr.c_str(), fmt.c_str(),
                                            rate, (int)bitrate, (int)quality, *cancelFlag);

  {
    std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex);
    g_pa_saveCancelFlags.erase(opId);
  }

  [rh cleanup];

  if (!err.empty()) {
    [wh cleanup]; pa_cleanupOutputFile(outputPath);
    NSString *code = @"AUDIO_SAVE_ENCODE_ERROR";
    NSString *nsErr = [NSString stringWithUTF8String:err.c_str()];
    if ([nsErr containsString:@"CANCELLED"]) code = @"AUDIO_SAVE_CANCELLED";
    reject(code, nsErr, nil);
    return;
  }

  [wh cleanup];
  resolve(@{ @"outputKind": outputKind, @"outputPath": resultPath });
}

// ---- Cancel audio save ----
- (void)cancelAudioSave:(NSString *)operationId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  std::string opId = [operationId UTF8String];
  {
    std::lock_guard<std::mutex> lock(g_pa_saveCancelMutex);
    auto it = g_pa_saveCancelFlags.find(opId);
    if (it != g_pa_saveCancelFlags.end()) {
      it->second->store(true);
    }
  }
  resolve(nil);
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
  if (g_pa_invalidated_live_ids.find(bid) != g_pa_invalidated_live_ids.end()) {
    reject(kPAErrBufferInvalidated, @"Live buffer is invalidated after transfer", nil);
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
    offIt->second->release();
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
  auto invalidatedIt = g_pa_invalidated_live_ids.find(bid);
  if (invalidatedIt != g_pa_invalidated_live_ids.end()) {
    g_pa_invalidated_live_ids.erase(invalidatedIt);
    resolve(nil);
    return;
  }
  resolve(nil); // idempotent
}

// ---- File Ingest to Live Buffer ----
- (void)startFileIngestToLiveBuffer:(NSString *)liveBufferId
                             source:(NSDictionary *)source
                   targetSampleRateHz:(double)targetSampleRateHz
                           forceMono:(BOOL)forceMono
                        autoFinalize:(BOOL)autoFinalize
                         backpressure:(NSString *)backpressure
                allowDemuxerAutoProbe:(BOOL)allowDemuxerAutoProbe
                         operationId:(NSString *)operationId
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
  std::string liveBufId = [liveBufferId UTF8String];
  std::string opId = [operationId UTF8String];
  std::string backpressureMode = backpressure ? [backpressure UTF8String] : "block";
  if (backpressureMode != "block" && backpressureMode != "none") {
    reject(kPAErrInvalidArgument, @"backpressure must be 'block' or 'none'", nil);
    return;
  }
  const bool useBackpressure = (backpressureMode == "block");

  // Validate live buffer
  auto liveEntry = pa_get_live_entry(liveBufId);
  if (!liveEntry) {
    if (pa_is_live_invalidated(liveBufId)) {
      reject(kPAErrBufferInvalidated, @"Live buffer is invalidated after transfer", nil);
    } else {
      reject(kPAErrBufferNotFound, @"Live buffer not found", nil);
    }
    return;
  }
  if (liveEntry->state != PaLiveEntry::RECORDING) {
    reject(kPAErrInvalidState, @"Live buffer must be in RECORDING state for file ingest", nil);
    return;
  }

  // Ensure spool is active — create a temporary one if the buffer was created without persistencePath
  if (!liveEntry->hasActiveSpool) {
    NSString *tmpSpoolPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"ingest_spool_%@.wav", [[NSUUID UUID] UUIDString]]];
    liveEntry->enableSpool([tmpSpoolPath UTF8String], true);
    if (!liveEntry->hasActiveSpool) {
      reject(@"AUDIO_SPOOL_ERROR", @"Failed to create temporary spool for file ingest", nil);
      return;
    }
  }

  // Register cancel flag + ingest status
  auto cancelFlag = std::make_shared<std::atomic<bool>>(false);
  std::string ingestId = pa_generate_id("ingest");
  {
    std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
    g_pa_decodeCancelFlags[opId] = cancelFlag;
  }
  auto status = std::make_shared<PaFileIngestStatus>();
  {
    std::lock_guard<std::mutex> lock(g_pa_fileIngestMutex);
    g_pa_fileIngestStatuses[ingestId] = status;
  }

  // Resolve file source
  NSString *errCode = nil, *errMsg = nil;
  FileIOReadHandle *readHandle = [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
  if (!readHandle) {
    {
      std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
      g_pa_decodeCancelFlags.erase(opId);
    }
    {
      std::lock_guard<std::mutex> lock(g_pa_fileIngestMutex);
      g_pa_fileIngestStatuses.erase(ingestId);
    }
    reject(errCode, errMsg, nil);
    return;
  }

  NSString *sourcePath = nil;
  NSString *tmpPath = nil;
  if (readHandle.isFilePath) {
    sourcePath = readHandle.filePath;
  } else {
    tmpPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
               [NSString stringWithFormat:@"fileio_buf_%@", [[NSUUID UUID] UUIDString]]];
    NSOutputStream *out = [NSOutputStream outputStreamToFileAtPath:tmpPath append:NO];
    [out open];
    [readHandle.stream open];
    uint8_t buf[65536];
    NSInteger bytesRead;
    while ((bytesRead = [readHandle.stream read:buf maxLength:sizeof(buf)]) > 0) {
      [out write:buf maxLength:bytesRead];
    }
    [out close];
    sourcePath = tmpPath;
  }

  // Resolve immediately with ingestId
  resolve(@{@"ingestId": [NSString stringWithUTF8String:ingestId.c_str()]});

  __weak SherpaOnnx *weakSelf = self;
  std::string path = [sourcePath UTF8String];

  dispatch_async(SherpaAudioDecodeQueue(), ^{
    int srcSampleRate = 0;
    int srcChannels = 0;

    try {
      sherpa::AudioDecodeConfig config;
      config.targetSampleRate = (int)targetSampleRateHz;
      config.forceMono = forceMono;
      config.chunkSize = 8192;
      config.allowDemuxerAutoProbe = allowDemuxerAutoProbe;

      auto onChunk = [&liveEntry, &status, useBackpressure, cancelFlag](const float *samples, int count) {
        if (cancelFlag->load()) return;
        auto appendResult = liveEntry->tryAppendSamples(
          samples,
          count,
          liveEntry->sampleRate,
          PaLiveAppendOrigin::ingress(PaLiveIngressSource::FileIngest),
          useBackpressure
        );
        if (appendResult == PaLiveEntry::AppendResult::APPENDED) {
          status->framesIngested += count;
          return;
        }
        cancelFlag->store(true);
      };

      auto onStreamInfo = [&srcSampleRate, &srcChannels](int sr, int ch) {
        srcSampleRate = sr;
        srcChannels = ch;
      };

      auto onProgress = [weakSelf, operationId, &srcSampleRate, &srcChannels, &status](
          int64_t framesDecoded, int64_t totalEstimate, int percent) {
        status->totalFramesEstimate = totalEstimate;
        status->percent = percent;
        SherpaOnnx *strongSelf = weakSelf;
        if (!strongSelf) return;
        dispatch_async(dispatch_get_main_queue(), ^{
          [strongSelf sendEventWithName:@"decodeProgress" body:@{
            @"operationId": operationId,
            @"framesDecoded": @((double)framesDecoded),
            @"totalFramesEstimate": @((double)totalEstimate),
            @"percent": @(percent),
            @"sourceSampleRate": @(srcSampleRate),
            @"sourceChannels": @(srcChannels),
          }];
        });
      };

      auto result = sherpa::decodeFile(path.c_str(), config, onChunk, onProgress, onStreamInfo, *cancelFlag);
      srcSampleRate = result.sourceSampleRate;
      srcChannels = result.sourceChannels;

      if (autoFinalize) {
        liveEntry->finalize_();
      }

      status->isRunning = false;
      status->percent = 100;

      SherpaOnnx *strongSelf = weakSelf;
      if (strongSelf) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [strongSelf sendEventWithName:@"decodeComplete" body:@{
            @"operationId": operationId,
            @"success": @YES,
            @"totalFramesIngested": @((double)status->framesIngested),
            @"sourceSampleRate": @(srcSampleRate),
            @"sourceChannels": @(srcChannels),
            @"autoFinalized": @(autoFinalize),
          }];
        });
      }
    } catch (const std::runtime_error &e) {
      std::string msg = e.what();
      status->isRunning = false;
      status->error = msg;

      NSString *nsMsg = [NSString stringWithUTF8String:msg.c_str()];
      NSString *nsCode = @"DECODE_INTERNAL_ERROR";
      if (msg.find("DECODE_") == 0) {
        auto colonPos = msg.find(':');
        if (colonPos != std::string::npos) {
          nsCode = [NSString stringWithUTF8String:msg.substr(0, colonPos).c_str()];
        }
      }

      SherpaOnnx *strongSelf = weakSelf;
      if (strongSelf) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [strongSelf sendEventWithName:@"decodeComplete" body:@{
            @"operationId": operationId,
            @"success": @NO,
            @"error": nsMsg,
            @"errorCode": nsCode,
          }];
        });
      }
    } catch (...) {
      status->isRunning = false;
      status->error = "Unknown error";

      SherpaOnnx *strongSelf = weakSelf;
      if (strongSelf) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [strongSelf sendEventWithName:@"decodeComplete" body:@{
            @"operationId": operationId,
            @"success": @NO,
            @"error": @"Unknown error during streaming decode",
            @"errorCode": @"DECODE_INTERNAL_ERROR",
          }];
        });
      }
    }

    // Cleanup
    {
      std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
      g_pa_decodeCancelFlags.erase(opId);
    }
    [readHandle cleanup];
    if (tmpPath) [[NSFileManager defaultManager] removeItemAtPath:tmpPath error:nil];
  });
}

// ---- File Ingest Status ----
- (void)getFileIngestStatus:(NSString *)ingestId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  std::string iId = [ingestId UTF8String];
  std::shared_ptr<PaFileIngestStatus> status;
  {
    std::lock_guard<std::mutex> lock(g_pa_fileIngestMutex);
    auto it = g_pa_fileIngestStatuses.find(iId);
    if (it != g_pa_fileIngestStatuses.end()) {
      status = it->second;
    }
  }

  if (!status) {
    resolve(@{
      @"isRunning": @NO,
      @"framesIngested": @(0.0),
      @"totalFramesEstimate": @(0.0),
      @"percent": @(0),
      @"error": [NSString stringWithFormat:@"Ingest not found: %@", ingestId],
    });
    return;
  }

  NSMutableDictionary *dict = [NSMutableDictionary dictionaryWithDictionary:@{
    @"isRunning": @(status->isRunning),
    @"framesIngested": @((double)status->framesIngested),
    @"totalFramesEstimate": @((double)status->totalFramesEstimate),
    @"percent": @(status->percent),
  }];
  if (!status->error.empty()) {
    dict[@"error"] = [NSString stringWithUTF8String:status->error.c_str()];
  }
  resolve(dict);
}

// ---- Cancel Decode ----
- (void)cancelDecode:(NSString *)operationId
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  std::string opId = [operationId UTF8String];
  {
    std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
    auto it = g_pa_decodeCancelFlags.find(opId);
    if (it != g_pa_decodeCancelFlags.end()) {
      it->second->store(true);
    }
  }
  resolve(nil);
}

#endif

@end
