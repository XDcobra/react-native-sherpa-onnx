#import "SherpaOnnx.h"
#import "SherpaOnnx+PipelineAudioGlobals.h"
#import "SherpaOnnx+TextBufferGlobals.h"

#include "sherpa-onnx-model-detect.h"
#include "sherpa_onnx_alignment_engine.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

static NSString *const kAlignmentErrCode = @"ALIGNMENT_ERROR";
static NSString *const kAlignmentErrTextBufferNotFound = @"ALIGNMENT_TEXT_BUFFER_NOT_FOUND";
static NSString *const kAlignmentErrTextBufferKindMismatch = @"ALIGNMENT_TEXT_BUFFER_KIND_MISMATCH";
static NSString *const kAlignmentErrTextBufferEmpty = @"ALIGNMENT_TEXT_BUFFER_EMPTY";
static NSString *const kAlignmentErrAudioBufferNotFound = @"ALIGNMENT_AUDIO_BUFFER_NOT_FOUND";
static NSString *const kAlignmentErrAudioBufferKindMismatch = @"ALIGNMENT_AUDIO_BUFFER_KIND_MISMATCH";
static NSString *const kAlignmentErrAudioBufferEmpty = @"ALIGNMENT_AUDIO_BUFFER_EMPTY";

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

  if (!result.detectionSources.empty()) {
    NSMutableArray *sources = [NSMutableArray arrayWithCapacity:result.detectionSources.size()];
    for (auto s : result.detectionSources) {
      [sources addObject:[NSString stringWithUTF8String:sherpaonnx::DetectionSourceToLiteral(s)]];
    }
    dict[@"detectionSources"] = sources;
  }

  if (!result.derivedLanguages.empty()) {
    NSMutableArray *langs = [NSMutableArray arrayWithCapacity:result.derivedLanguages.size()];
    for (const auto &lang : result.derivedLanguages) {
      [langs addObject:[NSString stringWithUTF8String:lang.c_str()] ?: @""];
    }
    dict[@"languages"] = langs;
  }

  if (!result.quantization.empty()) {
    dict[@"quantization"] = [NSString stringWithUTF8String:result.quantization.c_str()] ?: @"";
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

- (void)alignOfflineTextToAudio:(NSString *)textInBufferId
                 audioInBufferId:(NSString *)audioInBufferId
                            mode:(NSString *)mode
                     granularity:(NSString *)granularity
                         options:(NSDictionary *)options
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  if (textInBufferId == nil || [textInBufferId length] == 0) {
    reject(kAlignmentErrTextBufferNotFound, @"textInBufferId is required", nil);
    return;
  }
  if (audioInBufferId == nil || [audioInBufferId length] == 0) {
    reject(kAlignmentErrAudioBufferNotFound, @"audioInBufferId is required", nil);
    return;
  }

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    try {
      std::string textId = [textInBufferId UTF8String];
      std::string audioId = [audioInBufferId UTF8String];

      if (textId.find("txt_off_") != 0) {
        reject(kAlignmentErrTextBufferKindMismatch,
               [NSString stringWithFormat:@"Expected offline text buffer (txt_off_*), got: %@", textInBufferId],
               nil);
        return;
      }

      std::shared_ptr<TxtOfflineEntry> textEntry;
      {
        std::lock_guard<std::mutex> txtLock(g_txt_mutex);
        auto it = g_txt_offline.find(textId);
        if (it == g_txt_offline.end()) {
          if (g_txt_live.find(textId) != g_txt_live.end()) {
            reject(kAlignmentErrTextBufferKindMismatch,
                   [NSString stringWithFormat:@"Expected offline text buffer (txt_off_*), got live buffer: %@", textInBufferId],
                   nil);
          } else {
            reject(kAlignmentErrTextBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", textInBufferId],
                   nil);
          }
          return;
        }
        textEntry = it->second;
      }

      if (!textEntry->populated || textEntry->text.empty()) {
        reject(kAlignmentErrTextBufferEmpty,
               [NSString stringWithFormat:@"Offline text buffer is empty or not populated: %@", textInBufferId],
               nil);
        return;
      }

      if (audioId.find("off_") != 0) {
        reject(kAlignmentErrAudioBufferKindMismatch,
               [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got: %@", audioInBufferId],
               nil);
        return;
      }

      std::shared_ptr<PaOfflineEntry> audioEntry;
      {
        std::lock_guard<std::mutex> paLock(g_pa_mutex);
        auto it = g_pa_offline.find(audioId);
        if (it == g_pa_offline.end()) {
          if (g_pa_live.find(audioId) != g_pa_live.end()) {
            reject(kAlignmentErrAudioBufferKindMismatch,
                   [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got live buffer: %@", audioInBufferId],
                   nil);
          } else {
            reject(kAlignmentErrAudioBufferNotFound,
                   [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioInBufferId],
                   nil);
          }
          return;
        }
        audioEntry = it->second;
      }

      if (audioEntry->sampleRate <= 0 || audioEntry->numSamples() <= 0) {
        reject(kAlignmentErrAudioBufferEmpty,
               [NSString stringWithFormat:@"Offline audio buffer is empty: %@", audioInBufferId],
               nil);
        return;
      }

      std::string modeStr = NormalizeMode(mode);
      std::string granularityStr = NormalizeGranularity(granularity);

      sherpa_onnx::alignment::AlignmentResult result;
      if (modeStr == "proportional") {
        result = sherpa_onnx::alignment::AlignProportional(
            textEntry->text,
            audioEntry->numSamples(),
            audioEntry->sampleRate,
            granularityStr);
      } else if (modeStr == "estimated") {
        int32_t sr = ParseEstimatedSampleRate(options, audioEntry->sampleRate);
        auto counts = ParseSegmentSampleCounts(options);
        result = sherpa_onnx::alignment::AlignEstimated(
            textEntry->text,
            counts,
            sr,
            granularityStr);
      } else if (modeStr == "accurate") {
        std::string modelPathStr = ParseAlignmentModelPath(options);
        if (audioEntry->isFileBacked) {
          result = sherpa_onnx::alignment::AlignAccurateFromFile(
              modelPathStr,
              textEntry->text,
              audioEntry->filePath,
              granularityStr);
        } else {
          if (audioEntry->samples.empty()) {
            reject(kAlignmentErrAudioBufferEmpty,
                   [NSString stringWithFormat:@"Offline audio buffer is empty: %@", audioInBufferId],
                   nil);
            return;
          }
          result = sherpa_onnx::alignment::AlignAccurateFromPcm(
              modelPathStr,
              textEntry->text,
              audioEntry->samples.data(),
              audioEntry->samples.size(),
              audioEntry->sampleRate,
              granularityStr);
        }
      } else {
        throw std::runtime_error("Unsupported alignment mode");
      }

      resolve(AlignmentResultToNSDictionary(result));
    } catch (const std::exception &e) {
      NSString *errorMsg = [NSString stringWithUTF8String:e.what()] ?: @"Alignment failed";
      reject(kAlignmentErrCode, errorMsg, nil);
    } catch (...) {
      reject(kAlignmentErrCode, @"Alignment failed", nil);
    }
  });
}

@end
