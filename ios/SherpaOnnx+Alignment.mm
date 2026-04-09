#import "SherpaOnnx.h"
#import <AVFoundation/AVFoundation.h>

#include "sherpa-onnx-model-detect.h"
#include "sherpa_onnx_alignment_engine.hpp"
#include "tts/engine/TtsEngineStore.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

struct TtsSinkSnapshot {
  std::vector<float> samples;
  int32_t sampleRate = 0;
  int32_t numSamples = 0;
};

static NSString *alignmentKindToNSString(sherpaonnx::AlignmentModelKind kind) {
  using K = sherpaonnx::AlignmentModelKind;
  switch (kind) {
    case K::kWav2Vec2:
      return @"wav2vec2";
    default:
      return @"unknown";
  }
}

static NSDictionary *alignmentDetectResultToDict(
    const sherpaonnx::AlignmentDetectResult &result) {
  NSMutableArray *detectedModelsArray = [NSMutableArray array];
  for (const auto &model : result.detectedModels) {
    [detectedModelsArray addObject:@{
      @"type": [NSString stringWithUTF8String:model.type.c_str()] ?: @"",
      @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()] ?: @""
    }];
  }

  NSMutableDictionary *dict = [@{
    @"success": @(result.ok),
    @"detectedModels": detectedModelsArray,
    @"modelType": alignmentKindToNSString(result.selectedKind),
  } mutableCopy];
  if (!result.paths.model.empty()) {
    dict[@"paths"] = @{
      @"model": [NSString stringWithUTF8String:result.paths.model.c_str()] ?: @""
    };
  }
  if (!result.ok && !result.error.empty()) {
    dict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()] ?: @"Alignment model detection failed";
  }
  return dict;
}

static NSArray *SubtitleItemsToNSArray(
    const std::vector<sherpa_onnx::alignment::SubtitleItem> &items) {
  NSMutableArray *array = [NSMutableArray arrayWithCapacity:items.size()];
  for (const auto &item : items) {
    [array addObject:@{
      @"text": [NSString stringWithUTF8String:item.text.c_str()] ?: @"",
      @"start": @(item.start_s),
      @"end": @(item.end_s),
    }];
  }
  return array;
}

static NSDictionary *AlignmentResultToNSDictionary(
    const sherpa_onnx::alignment::AlignmentResult &r) {
  return @{
    @"subtitles": SubtitleItemsToNSArray(r.subtitles),
    @"timingMode": [NSString stringWithUTF8String:r.timing_mode.c_str()] ?: @"",
  };
}

static uint32_t ReadLE32File(FILE *f) {
  uint8_t b[4];
  if (fread(b, 1, 4, f) != 4) {
    return 0;
  }
  return static_cast<uint32_t>(b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24));
}

static uint16_t ReadLE16File(FILE *f) {
  uint8_t b[2];
  if (fread(b, 1, 2, f) != 2) {
    return 0;
  }
  return static_cast<uint16_t>(b[0] | (b[1] << 8));
}

/** 16-bit mono PCM WAV only; returns false if unsupported. */
static bool ReadPcmWavFileMetrics(const std::string &path, int32_t *outRate, int32_t *outTotalSamples) {
  FILE *fp = fopen(path.c_str(), "rb");
  if (!fp) {
    return false;
  }
  char riff[4];
  if (fread(riff, 1, 4, fp) != 4 || memcmp(riff, "RIFF", 4) != 0) {
    fclose(fp);
    return false;
  }
  (void)ReadLE32File(fp);
  char wave[4];
  if (fread(wave, 1, 4, fp) != 4 || memcmp(wave, "WAVE", 4) != 0) {
    fclose(fp);
    return false;
  }

  int32_t sampleRate = 0;
  int32_t blockAlign = 1;
  int64_t dataSize = -1;

  while (!feof(fp)) {
    char id[4];
    if (fread(id, 1, 4, fp) != 4) {
      break;
    }
    uint32_t cs = ReadLE32File(fp);
    long chunkDataStart = ftell(fp);

    if (memcmp(id, "fmt ", 4) == 0) {
      if (cs < 16) {
        fseek(fp, chunkDataStart + static_cast<long>(cs) + static_cast<long>(cs & 1), SEEK_SET);
        continue;
      }
      uint16_t audioFormat = ReadLE16File(fp);
      uint16_t numChannels = ReadLE16File(fp);
      uint32_t sr = ReadLE32File(fp);
      (void)ReadLE32File(fp);
      uint16_t ba = ReadLE16File(fp);
      uint16_t bps = ReadLE16File(fp);
      if (audioFormat != 1 || numChannels != 1 || bps != 16) {
        fclose(fp);
        return false;
      }
      sampleRate = static_cast<int32_t>(sr);
      blockAlign = static_cast<int32_t>(ba);
      if (blockAlign <= 0) {
        fclose(fp);
        return false;
      }
      fseek(fp, chunkDataStart + static_cast<long>(cs) + static_cast<long>(cs & 1), SEEK_SET);
    } else if (memcmp(id, "data", 4) == 0) {
      dataSize = static_cast<int64_t>(cs);
      break;
    } else {
      fseek(fp, chunkDataStart + static_cast<long>(cs) + static_cast<long>(cs & 1), SEEK_SET);
    }
  }
  fclose(fp);
  if (sampleRate <= 0 || dataSize < 0 || blockAlign <= 0) {
    return false;
  }
  *outRate = sampleRate;
  *outTotalSamples = static_cast<int32_t>(dataSize / blockAlign);
  return true;
}

static std::string NormalizeAudioPathToLocalFile(NSString *audioPath) {
  if (audioPath == nil) {
    return "";
  }
  NSString *trimmed = [audioPath stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (trimmed == nil || trimmed.length == 0) {
    return "";
  }
  if ([trimmed hasPrefix:@"file://"]) {
    NSURL *url = [NSURL URLWithString:trimmed];
    NSString *p = url.path;
    if (p != nil && p.length > 0) {
      return std::string([p UTF8String]);
    }
  }
  return std::string([trimmed UTF8String]);
}

static bool ReadAudioDurationAny(
    const std::string &path,
    int32_t *outRate,
    int32_t *outTotalSamples) {
  if (ReadPcmWavFileMetrics(path, outRate, outTotalSamples)) {
    return true;
  }

  @autoreleasepool {
    NSString *nsPath = [NSString stringWithUTF8String:path.c_str()];
    if (nsPath == nil || nsPath.length == 0) {
      return false;
    }
    NSURL *url = [NSURL fileURLWithPath:nsPath];
    NSError *err = nil;
    AVAudioFile *audioFile = [[AVAudioFile alloc] initForReading:url error:&err];
    if (audioFile == nil || err != nil) {
      return false;
    }
    double sr = audioFile.fileFormat.sampleRate;
    if (sr <= 0) {
      sr = audioFile.processingFormat.sampleRate;
    }
    AVAudioFramePosition frameLength = audioFile.length;
    if (sr <= 0 || frameLength <= 0) {
      return false;
    }
    *outRate = static_cast<int32_t>(llround(sr));
    *outTotalSamples = static_cast<int32_t>(std::max<int64_t>(0, static_cast<int64_t>(frameLength)));
    return *outRate > 0 && *outTotalSamples >= 0;
  }
}

static std::vector<int32_t> ParseSegmentSampleCounts(NSDictionary *options) {
  if (options == nil) {
    throw std::runtime_error("ALIGNMENT_CHUNKS_MISSING: Provide options.segmentSampleCounts for estimated mode.");
  }

  id raw = options[@"segmentSampleCounts"];
  if (raw == nil) {
    id chunks = options[@"chunks"];
    if ([chunks isKindOfClass:[NSDictionary class]]) {
      raw = ((NSDictionary *)chunks)[@"segmentSampleCounts"];
    }
  }

  if (![raw isKindOfClass:[NSArray class]]) {
    throw std::runtime_error("ALIGNMENT_CHUNKS_MISSING: Provide options.segmentSampleCounts for estimated mode.");
  }

  NSArray *arr = (NSArray *)raw;
  std::vector<int32_t> out;
  out.reserve(arr.count);
  for (id v in arr) {
    if (![v isKindOfClass:[NSNumber class]]) {
      out.push_back(0);
      continue;
    }
    double x = [(NSNumber *)v doubleValue];
    if (!std::isfinite(x)) {
      out.push_back(0);
      continue;
    }
    int32_t n = static_cast<int32_t>(x);
    out.push_back(std::max<int32_t>(0, n));
  }
  return out;
}

static int32_t ParseEstimatedSampleRate(
    NSDictionary *options,
    int32_t fallbackSampleRate) {
  if (options != nil) {
    id direct = options[@"sampleRate"];
    if ([direct isKindOfClass:[NSNumber class]]) {
      double v = [(NSNumber *)direct doubleValue];
      if (std::isfinite(v) && v > 0) {
        return static_cast<int32_t>(v);
      }
    }

    id chunks = options[@"chunks"];
    if ([chunks isKindOfClass:[NSDictionary class]]) {
      id nested = ((NSDictionary *)chunks)[@"sampleRate"];
      if ([nested isKindOfClass:[NSNumber class]]) {
        double v = [(NSNumber *)nested doubleValue];
        if (std::isfinite(v) && v > 0) {
          return static_cast<int32_t>(v);
        }
      }
    }
  }

  return fallbackSampleRate;
}

static std::string ParseAlignmentModelPath(NSDictionary *options) {
  NSString *path = [options[@"alignmentModelPath"] isKindOfClass:[NSString class]]
      ? options[@"alignmentModelPath"]
      : nil;
  NSString *trimmed = path != nil
      ? [path stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
      : @"";
  if (trimmed == nil || trimmed.length == 0) {
    throw std::runtime_error("ALIGNMENT_MODEL_MISSING: Provide options.alignmentModelPath for accurate alignment.");
  }
  return std::string([trimmed UTF8String]);
}

static std::string NormalizeMode(NSString *mode) {
  NSString *m = [mode isKindOfClass:[NSString class]]
      ? [[mode lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
      : @"";
  if ([m isEqualToString:@"proportional"]) return "proportional";
  if ([m isEqualToString:@"estimated"]) return "estimated";
  if ([m isEqualToString:@"accurate"]) return "accurate";
  throw std::runtime_error("Unsupported alignment mode");
}

static std::string NormalizeGranularity(NSString *granularity) {
  NSString *g = [granularity isKindOfClass:[NSString class]]
      ? [[granularity lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
      : @"";
  if (g == nil || g.length == 0 || [g isEqualToString:@"sentence"]) return "sentence";
  if ([g isEqualToString:@"word"]) return "word";
  if ([g isEqualToString:@"character"]) return "character";
  throw std::runtime_error("Unsupported alignment granularity");
}

static TtsSinkSnapshot ReadTtsSinkSnapshot(NSString *instanceId, double generation) {
  if (instanceId == nil || instanceId.length == 0) {
    throw std::runtime_error("generatedAudio._instanceId is required");
  }

  std::string instanceIdStr([instanceId UTF8String]);
  std::lock_guard<std::mutex> lock(g_tts_mutex);
  auto it = g_tts_instances.find(instanceIdStr);
  if (it == g_tts_instances.end()) {
    throw std::runtime_error("TTS instance not found");
  }

  auto &sink = it->second->sink;
  uint64_t requestedGen = static_cast<uint64_t>(generation);
  if (sink.generation == 0 || sink.samples.empty()) {
    throw std::runtime_error("No batch synthesis result available for this TTS instance");
  }
  if (requestedGen != sink.generation) {
    throw std::runtime_error("TTS generation is stale");
  }

  TtsSinkSnapshot out;
  out.samples = sink.samples;
  out.sampleRate = sink.sampleRate;
  out.numSamples = sink.numSamples;
  return out;
}

}  // namespace

@implementation SherpaOnnx (Alignment)

- (void)detectAlignmentModel:(NSString *)modelDir
                  modelType:(NSString *)modelType
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string modelDirStr = (modelDir != nil) ? [modelDir UTF8String] : "";
    std::string modelTypeStr =
        (modelType != nil && [modelType length] > 0) ? [modelType UTF8String]
                                                      : "auto";
    auto result = sherpaonnx::DetectAlignmentModel(modelDirStr, modelTypeStr);
    resolve(alignmentDetectResultToDict(result));
  } @catch (NSException *exception) {
    reject(@"DETECT_ERROR",
           [NSString stringWithFormat:@"Alignment detect failed: %@",
                                      exception.reason],
           nil);
  }
}

- (void)alignTextToAudioFromPath:(NSString *)text
                    audioPath:(NSString *)audioPath
                             mode:(NSString *)mode
                      granularity:(NSString *)granularity
                          options:(NSDictionary *)options
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  if (text == nil || [text length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"text is required", nil);
    return;
  }
  if (audioPath == nil || [audioPath length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"audioPath is required", nil);
    return;
  }

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    try {
      std::string textStr([text UTF8String]);
      std::string audioPathStr = NormalizeAudioPathToLocalFile(audioPath);
      std::string modeStr = NormalizeMode(mode);
      std::string granularityStr = NormalizeGranularity(granularity);

      sherpa_onnx::alignment::AlignmentResult result;

      if (modeStr == "proportional") {
        int32_t sr = 0;
        int32_t total = 0;
        if (!ReadAudioDurationAny(audioPathStr, &sr, &total)) {
          throw std::runtime_error("Could not read audio duration");
        }
        result = sherpa_onnx::alignment::AlignProportional(textStr, total, sr, granularityStr);
      } else if (modeStr == "estimated") {
        int32_t sr = 0;
        int32_t total = 0;
        if (!ReadAudioDurationAny(audioPathStr, &sr, &total)) {
          throw std::runtime_error("Could not read audio duration");
        }
        (void)total;
        sr = ParseEstimatedSampleRate(options, sr);
        auto counts = ParseSegmentSampleCounts(options);
        result = sherpa_onnx::alignment::AlignEstimated(textStr, counts, sr, granularityStr);
      } else if (modeStr == "accurate") {
        std::string modelPathStr = ParseAlignmentModelPath(options);
        result = sherpa_onnx::alignment::AlignAccurateFromFile(
            modelPathStr,
            textStr,
            audioPathStr,
            granularityStr);
      } else {
        throw std::runtime_error("Unsupported alignment mode");
      }

      resolve(AlignmentResultToNSDictionary(result));
    } catch (const std::exception &e) {
      NSString *errorMsg = [NSString stringWithUTF8String:e.what()] ?: @"Alignment failed";
      reject(@"ALIGNMENT_ERROR", errorMsg, nil);
    } catch (...) {
      reject(@"ALIGNMENT_ERROR", @"Alignment failed", nil);
    }
  });
}

- (void)alignTextToAudioFromPcm:(NSString *)text
                         samples:(NSArray *)samples
                      sampleRate:(double)sampleRate
                            mode:(NSString *)mode
                     granularity:(NSString *)granularity
                         options:(NSDictionary *)options
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  if (text == nil || [text length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"text is required", nil);
    return;
  }
  if (samples == nil || [samples count] == 0) {
    reject(@"ALIGNMENT_ERROR", @"samples is required", nil);
    return;
  }
  if (sampleRate <= 0.0) {
    reject(@"ALIGNMENT_ERROR", @"sampleRate must be positive", nil);
    return;
  }

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    try {
      std::string textStr([text UTF8String]);
      std::string modeStr = NormalizeMode(mode);
      std::string granularityStr = NormalizeGranularity(granularity);

      std::vector<float> raw;
      raw.reserve([samples count]);
      for (id x in samples) {
        raw.push_back(static_cast<float>([x doubleValue]));
      }

      int32_t sr = static_cast<int32_t>(sampleRate);
      sherpa_onnx::alignment::AlignmentResult result;

      if (modeStr == "proportional") {
        result = sherpa_onnx::alignment::AlignProportional(
            textStr,
            static_cast<int32_t>(raw.size()),
            sr,
            granularityStr);
      } else if (modeStr == "estimated") {
        sr = ParseEstimatedSampleRate(options, sr);
        auto counts = ParseSegmentSampleCounts(options);
        result = sherpa_onnx::alignment::AlignEstimated(textStr, counts, sr, granularityStr);
      } else if (modeStr == "accurate") {
        std::string modelPathStr = ParseAlignmentModelPath(options);
        result = sherpa_onnx::alignment::AlignAccurateFromPcm(
            modelPathStr,
            textStr,
            raw.data(),
            raw.size(),
            sr,
            granularityStr);
        } else {
        throw std::runtime_error("Unsupported alignment mode");
      }

      resolve(AlignmentResultToNSDictionary(result));
    } catch (const std::exception &e) {
      NSString *errorMsg = [NSString stringWithUTF8String:e.what()] ?: @"Alignment failed";
      reject(@"ALIGNMENT_ERROR", errorMsg, nil);
    } catch (...) {
      reject(@"ALIGNMENT_ERROR", @"Alignment failed", nil);
    }
  });
}

- (void)alignTextToTtsSink:(NSDictionary *)generatedAudio
                      text:(NSString *)text
                      mode:(NSString *)mode
               granularity:(NSString *)granularity
                   options:(NSDictionary *)options
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  if (text == nil || [text length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"text is required", nil);
        return;
      }
  if (generatedAudio == nil || ![generatedAudio isKindOfClass:[NSDictionary class]]) {
    reject(@"ALIGNMENT_ERROR", @"generatedAudio is required", nil);
        return;
      }

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    try {
      NSString *instanceId = [generatedAudio[@"_instanceId"] isKindOfClass:[NSString class]]
          ? generatedAudio[@"_instanceId"]
          : ([generatedAudio[@"instanceId"] isKindOfClass:[NSString class]] ? generatedAudio[@"instanceId"] : nil);
      NSNumber *generationNum = [generatedAudio[@"generation"] isKindOfClass:[NSNumber class]]
          ? generatedAudio[@"generation"]
          : nil;
      if (instanceId == nil || generationNum == nil) {
        throw std::runtime_error("generatedAudio._instanceId and generatedAudio.generation are required");
      }

      std::string textStr([text UTF8String]);
      std::string modeStr = NormalizeMode(mode);
      std::string granularityStr = NormalizeGranularity(granularity);
      TtsSinkSnapshot sink = ReadTtsSinkSnapshot(instanceId, [generationNum doubleValue]);

      sherpa_onnx::alignment::AlignmentResult result;
      if (modeStr == "proportional") {
        result = sherpa_onnx::alignment::AlignProportional(
            textStr,
            sink.numSamples,
            sink.sampleRate,
            granularityStr);
      } else if (modeStr == "estimated") {
        const int32_t estimatedRate =
            ParseEstimatedSampleRate(options, sink.sampleRate);
        auto counts = ParseSegmentSampleCounts(options);
        result = sherpa_onnx::alignment::AlignEstimated(
            textStr,
            counts,
            estimatedRate,
            granularityStr);
      } else if (modeStr == "accurate") {
        std::string modelPathStr = ParseAlignmentModelPath(options);
        result = sherpa_onnx::alignment::AlignAccurateFromPcm(
            modelPathStr,
            textStr,
            sink.samples.data(),
            sink.samples.size(),
            sink.sampleRate,
            granularityStr);
      } else {
        throw std::runtime_error("Unsupported alignment mode");
      }

      resolve(AlignmentResultToNSDictionary(result));
    } catch (const std::exception &e) {
      NSString *errorMsg = [NSString stringWithUTF8String:e.what()] ?: @"Alignment failed";
      reject(@"ALIGNMENT_ERROR", errorMsg, nil);
    } catch (...) {
      reject(@"ALIGNMENT_ERROR", @"Alignment failed", nil);
    }
  });
}

- (void)getAudioDuration:(NSString *)audioPath
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  if (audioPath == nil || [audioPath length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"audioPath is required", nil);
    return;
  }

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    try {
      std::string pathStr = NormalizeAudioPathToLocalFile(audioPath);
      int32_t rate = 0;
      int32_t total = 0;
      if (!ReadAudioDurationAny(pathStr, &rate, &total)) {
        throw std::runtime_error("Could not read audio duration");
      }
      resolve(@{
        @"sampleRate": @(rate),
        @"totalSamples": @(total),
      });
    } catch (const std::exception &e) {
      NSString *errorMsg = [NSString stringWithUTF8String:e.what()] ?: @"Audio duration failed";
      reject(@"ALIGNMENT_ERROR", errorMsg, nil);
    } catch (...) {
      reject(@"ALIGNMENT_ERROR", @"Audio duration failed", nil);
    }
  });
}

@end
