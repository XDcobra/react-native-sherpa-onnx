#import "SherpaOnnx.h"
#import <React/RCTLog.h>

#include "sherpa-onnx/c-api/cxx-api.h"
#include "sherpa-onnx-model-detect.h"
#include "sherpa_onnx_ctc_alignment.hpp"

#include <cstdio>
#include <cstring>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

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

static NSArray *AlignmentIntervalsToNSArray(
    const std::vector<sherpa_onnx::ctc_alignment::AlignmentInterval> &items) {
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

static NSDictionary *CtcResultToNSDictionary(const sherpa_onnx::ctc_alignment::CtcAlignmentResult &r) {
  return @{
    @"words": AlignmentIntervalsToNSArray(r.words),
    @"chars": AlignmentIntervalsToNSArray(r.chars),
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

static NSDictionary *TryRunCtcAlignmentFromRawPcm(
    const std::string &modelPathStr,
    const std::string &textStr,
    NSString *vocabJson,
    std::vector<float> rawSamples,
    int32_t sourceSampleRate) {
  if (vocabJson == nil || vocabJson.length == 0) {
    throw std::runtime_error("Vocabulary JSON is empty");
  }
  std::string vocabUtf8([vocabJson UTF8String] ?: "");
  auto result = sherpa_onnx::ctc_alignment::RunCtcAlignmentFromFloatPcm(
      modelPathStr,
      textStr,
      vocabUtf8,
      rawSamples.data(),
      rawSamples.size(),
      sourceSampleRate);
  return CtcResultToNSDictionary(result);
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

- (void)alignAccurateFromPath:(NSString *)modelPath
                    audioPath:(NSString *)audioPath
                         text:(NSString *)text
                    vocabJson:(NSString *)vocabJson
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  if (modelPath == nil || [modelPath length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"modelPath is required", nil);
    return;
  }
  if (audioPath == nil || [audioPath length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"audioPath is required", nil);
    return;
  }
  if (text == nil || [text length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"text is required", nil);
    return;
  }

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    try {
      std::string modelPathStr([modelPath UTF8String]);
      std::string audioPathStr([audioPath UTF8String]);
      std::string textStr([text UTF8String]);

      sherpa_onnx::cxx::Wave wave = sherpa_onnx::cxx::ReadWave(audioPathStr);
      if (wave.samples.empty() || wave.sample_rate <= 0) {
        reject(@"ALIGNMENT_ERROR", @"Failed to read WAV audio for alignment", nil);
        return;
      }

      NSDictionary *result = TryRunCtcAlignmentFromRawPcm(modelPathStr, textStr, vocabJson, wave.samples, wave.sample_rate);
      resolve(result);
    } catch (const std::exception &e) {
      NSString *errorMsg = [NSString stringWithUTF8String:e.what()] ?: @"CTC alignment failed";
      reject(@"ALIGNMENT_ERROR", errorMsg, nil);
    } catch (...) {
      reject(@"ALIGNMENT_ERROR", @"CTC alignment failed", nil);
    }
  });
}

- (void)alignAccurateFromFloat32:(NSString *)modelPath
                         samples:(NSArray *)samples
                      sampleRate:(double)sampleRate
                            text:(NSString *)text
                       vocabJson:(NSString *)vocabJson
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  if (modelPath == nil || [modelPath length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"modelPath is required", nil);
    return;
  }
  if (samples == nil || [samples count] == 0) {
    reject(@"ALIGNMENT_ERROR", @"samples is required", nil);
    return;
  }
  if (text == nil || [text length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"text is required", nil);
    return;
  }
  if (sampleRate <= 0.0) {
    reject(@"ALIGNMENT_ERROR", @"sampleRate must be positive", nil);
    return;
  }

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    try {
      std::string modelPathStr([modelPath UTF8String]);
      std::string textStr([text UTF8String]);
      std::vector<float> raw;
      raw.reserve([samples count]);
      for (id x in samples) {
        raw.push_back(static_cast<float>([x doubleValue]));
      }
      int32_t sr = static_cast<int32_t>(sampleRate);
      NSDictionary *result = TryRunCtcAlignmentFromRawPcm(modelPathStr, textStr, vocabJson, raw, sr);
      resolve(result);
    } catch (const std::exception &e) {
      NSString *errorMsg = [NSString stringWithUTF8String:e.what()] ?: @"CTC alignment failed";
      reject(@"ALIGNMENT_ERROR", errorMsg, nil);
    } catch (...) {
      reject(@"ALIGNMENT_ERROR", @"CTC alignment failed", nil);
    }
  });
}

- (void)getAlignmentAudioMetrics:(NSString *)audioPath
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  if (audioPath == nil || [audioPath length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"audioPath is required", nil);
    return;
  }
  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    try {
      std::string pathStr([audioPath UTF8String]);
      int32_t rate = 0;
      int32_t total = 0;
      if (!ReadPcmWavFileMetrics(pathStr, &rate, &total)) {
        reject(@"ALIGNMENT_ERROR",
               @"Fast metrics require 16-bit mono PCM WAV. For other formats, decode in app code first.",
               nil);
        return;
      }
      resolve(@{
        @"sampleRate": @(rate),
        @"totalSamples": @(total),
      });
    } catch (const std::exception &e) {
      NSString *errorMsg = [NSString stringWithUTF8String:e.what()] ?: @"WAV metrics failed";
      reject(@"ALIGNMENT_ERROR", errorMsg, nil);
    } catch (...) {
      reject(@"ALIGNMENT_ERROR", @"WAV metrics failed", nil);
    }
  });
}

@end
