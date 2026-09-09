#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../core/LanguageIdBridgeState.h"

#include <chrono>
#include <cmath>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

dispatch_queue_t LanguageIdSerialQueue() {
  static dispatch_queue_t queue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    queue = dispatch_queue_create("com.sherpaonnx.languageid", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

}  // namespace

@implementation SherpaOnnx (LanguageIdOffline)

- (void)initializeLanguageId:(NSString *)instanceId
                     options:(JS::NativeSherpaOnnx::LanguageIdInitBridgeOptions &)options
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"LANGUAGE_ID_INIT_ERROR", @"instanceId is required", nil);
    return;
  }

  NSString *encoder = options.encoder();
  NSString *decoder = options.decoder();
  if (encoder == nil || [encoder length] == 0 || decoder == nil || [decoder length] == 0) {
    reject(@"LANGUAGE_ID_INIT_ERROR", @"encoder and decoder paths are required", nil);
    return;
  }

  const std::string instanceIdStr = [instanceId UTF8String];
  const std::string encoderStr = [encoder UTF8String];
  const std::string decoderStr = [decoder UTF8String];

  const int32_t tailPaddings = options.tailPaddings().has_value()
      ? static_cast<int32_t>(options.tailPaddings().value())
      : -1;
  const int32_t numThreads = options.numThreads().has_value()
      ? std::max<int32_t>(1, static_cast<int32_t>(options.numThreads().value()))
      : 1;
  const bool debug = options.debug().has_value() ? options.debug().value() : false;
  std::string provider = "cpu";
  if (options.provider() != nil && [options.provider() length] > 0) {
    provider = [options.provider() UTF8String];
  }

  dispatch_async(LanguageIdSerialQueue(), ^{
    @try {
      SherpaOnnxSpokenLanguageIdentificationConfig config;
      std::memset(&config, 0, sizeof(config));
      config.whisper.encoder = encoderStr.c_str();
      config.whisper.decoder = decoderStr.c_str();
      config.whisper.tail_paddings = tailPaddings;
      config.num_threads = numThreads;
      config.debug = debug ? 1 : 0;
      config.provider = provider.c_str();

      const SherpaOnnxSpokenLanguageIdentification *handle =
          SherpaOnnxCreateSpokenLanguageIdentification(&config);

      if (handle == nullptr) {
        reject(@"LANGUAGE_ID_INIT_ERROR",
               @"Failed to create native SherpaOnnxSpokenLanguageIdentification instance",
               nil);
        return;
      }

      auto state = std::make_shared<sherpaonnx::language_id::bridge::LanguageIdInstanceState>();
      state->handle = handle;
      state->numThreads = numThreads;
      state->provider = provider;

      {
        std::lock_guard<std::mutex> lock(
            sherpaonnx::language_id::bridge::g_language_id_mutex);
        sherpaonnx::language_id::bridge::g_language_id_instances[instanceIdStr] = state;
      }

      resolve(@{ @"success": @YES });
    } @catch (NSException *exception) {
      reject(@"LANGUAGE_ID_INIT_ERROR",
             [NSString stringWithFormat:@"Language ID init failed: %@", exception.reason],
             nil);
    }
  });
}

- (void)identifyLanguageOffline:(NSString *)instanceId
                  audioBufferId:(NSString *)audioBufferId
                    startSample:(NSNumber *)startSample
                      endSample:(NSNumber *)endSample
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"LANGUAGE_ID_IDENTIFY_FAILED", @"instanceId is required", nil);
    return;
  }
  if (audioBufferId == nil || [audioBufferId length] == 0) {
    reject(@"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND", @"audioBufferId is required", nil);
    return;
  }

  const bool hasStart = startSample != nil;
  const bool hasEnd = endSample != nil;
  if (hasStart != hasEnd) {
    reject(@"LANGUAGE_ID_INVALID_ARGUMENT",
           @"startSample and endSample must both be provided or both omitted",
           nil);
    return;
  }

  const std::string instanceIdStr = [instanceId UTF8String];
  const std::string audioInId = [audioBufferId UTF8String];

  if (audioInId.find("off_") != 0) {
    reject(@"LANGUAGE_ID_INVALID_ARGUMENT",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got: %@", audioBufferId],
           nil);
    return;
  }

  auto state = sherpaonnx::language_id::bridge::LookupLanguageId(instanceIdStr);
  if (!state || state->handle == nullptr) {
    reject(@"LANGUAGE_ID_NOT_INITIALIZED",
           [NSString stringWithFormat:@"SLID instance not found: %@", instanceId],
           nil);
    return;
  }

  int inSampleRate = 0;
  int inNumSamples = 0;
  std::string errCode;
  std::string errMsg;
  if (!pa_get_offline_metadata(audioInId, &inSampleRate, &inNumSamples, &errCode, &errMsg)) {
    reject(@"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioBufferId],
           nil);
    return;
  }
  if (inSampleRate <= 0 || inNumSamples <= 0) {
    reject(@"LANGUAGE_ID_AUDIO_BUFFER_EMPTY",
           [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioBufferId],
           nil);
    return;
  }

  dispatch_async(LanguageIdSerialQueue(), ^{
    @try {
      std::vector<float> samples;
      int sampleRate = inSampleRate;

      if (!hasStart) {
        if (!pa_read_offline_samples(audioInId, &samples, &sampleRate) || samples.empty()) {
          reject(@"LANGUAGE_ID_AUDIO_BUFFER_EMPTY",
                 [NSString stringWithFormat:@"Offline audio buffer is empty: %@", audioBufferId],
                 nil);
          return;
        }
      } else {
        const int start = std::max(0, static_cast<int>(std::floor([startSample doubleValue])));
        const int endRaw = std::max(start, static_cast<int>(std::floor([endSample doubleValue])));
        const int end = std::min(endRaw, inNumSamples);
        const int frameCount = std::max(0, end - start);
        if (frameCount == 0) {
          resolve(@{
            @"lang": @"",
            @"audioDuration": @(0.0),
            @"elapsedMs": @(0.0),
          });
          return;
        }
        std::string sliceErrCode;
        std::string sliceErrMsg;
        if (!pa_get_offline_samples_slice(
                audioInId, start, frameCount, &samples, &sliceErrCode, &sliceErrMsg)) {
          NSString *code = sliceErrCode.empty()
              ? @"LANGUAGE_ID_IDENTIFY_FAILED"
              : [NSString stringWithUTF8String:sliceErrCode.c_str()];
          NSString *msg = sliceErrMsg.empty()
              ? @"Failed to read offline audio slice"
              : [NSString stringWithUTF8String:sliceErrMsg.c_str()];
          reject(code, msg, nil);
          return;
        }
      }

      const auto t0 = std::chrono::steady_clock::now();
      const double audioDuration = (sampleRate > 0)
          ? static_cast<double>(samples.size()) / static_cast<double>(sampleRate)
          : 0.0;

      SherpaOnnxOfflineStream *stream =
          SherpaOnnxSpokenLanguageIdentificationCreateOfflineStream(state->handle);
      if (stream == nullptr) {
        reject(@"LANGUAGE_ID_IDENTIFY_FAILED", @"Failed to create offline stream", nil);
        return;
      }

      SherpaOnnxAcceptWaveformOffline(
          stream,
          sampleRate,
          samples.data(),
          static_cast<int32_t>(samples.size()));

      const SherpaOnnxSpokenLanguageIdentificationResult *result =
          SherpaOnnxSpokenLanguageIdentificationCompute(state->handle, stream);

      SherpaOnnxDestroyOfflineStream(stream);

      if (result == nullptr || result->lang == nullptr) {
        if (result != nullptr) {
          SherpaOnnxDestroySpokenLanguageIdentificationResult(result);
        }
        reject(@"LANGUAGE_ID_IDENTIFY_FAILED", @"Language identification compute returned null", nil);
        return;
      }

      NSString *langStr = [NSString stringWithUTF8String:result->lang];
      SherpaOnnxDestroySpokenLanguageIdentificationResult(result);

      const auto t1 = std::chrono::steady_clock::now();
      const double elapsedMs =
          std::chrono::duration<double, std::milli>(t1 - t0).count();

      resolve(@{
        @"lang": langStr ?: @"",
        @"audioDuration": @(audioDuration),
        @"elapsedMs": @(elapsedMs),
      });
    } @catch (NSException *exception) {
      reject(@"LANGUAGE_ID_IDENTIFY_FAILED",
             [NSString stringWithFormat:@"Language identification failed: %@", exception.reason],
             nil);
    }
  });
}

- (void)unloadLanguageId:(NSString *)instanceId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }
  const std::string instanceIdStr = [instanceId UTF8String];
  dispatch_async(LanguageIdSerialQueue(), ^{
    sherpaonnx::language_id::bridge::RemoveLanguageId(instanceIdStr);
    resolve(nil);
  });
}

- (void)labelLanguageIdOfflineSegments:(NSString *)instanceId
                             audioInId:(NSString *)audioInId
                          segmentsInId:(NSString *)segmentsInId
                         segmentsOutId:(NSString *)segmentsOutId
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"LANGUAGE_ID_INIT_ERROR", @"instanceId is required", nil);
    return;
  }
  if (audioInId == nil || [audioInId length] == 0) {
    reject(@"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND", @"audioInId is required", nil);
    return;
  }
  if (segmentsInId == nil || [segmentsInId length] == 0) {
    reject(@"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND", @"segmentsInId is required", nil);
    return;
  }
  if (segmentsOutId == nil || [segmentsOutId length] == 0) {
    reject(@"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND", @"segmentsOutId is required", nil);
    return;
  }

  const std::string instanceIdStr = [instanceId UTF8String];
  const std::string audioInIdStr = [audioInId UTF8String];
  const std::string segmentsInIdStr = [segmentsInId UTF8String];
  const std::string segmentsOutIdStr = [segmentsOutId UTF8String];

  if (audioInIdStr.find("off_") != 0) {
    reject(@"LANGUAGE_ID_INVALID_ARGUMENT",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got: %@", audioInId],
           nil);
    return;
  }
  if (segmentsInIdStr.find("seg_off_") != 0) {
    reject(@"LANGUAGE_ID_INVALID_ARGUMENT",
           [NSString stringWithFormat:@"Expected offline segment buffer (seg_off_*) for segmentsIn, got: %@", segmentsInId],
           nil);
    return;
  }
  if (segmentsOutIdStr.find("seg_off_") != 0) {
    reject(@"LANGUAGE_ID_INVALID_ARGUMENT",
           [NSString stringWithFormat:@"Expected offline segment buffer (seg_off_*) for segmentsOut, got: %@", segmentsOutId],
           nil);
    return;
  }

  auto state = sherpaonnx::language_id::bridge::LookupLanguageId(instanceIdStr);
  if (!state || state->handle == nullptr) {
    reject(@"LANGUAGE_ID_NOT_INITIALIZED",
           [NSString stringWithFormat:@"SLID instance not found: %@", instanceId],
           nil);
    return;
  }

  int inSampleRate = 0;
  int inNumSamples = 0;
  std::string errCode;
  std::string errMsg;
  if (!pa_get_offline_metadata(audioInIdStr, &inSampleRate, &inNumSamples, &errCode, &errMsg)) {
    reject(@"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioInId],
           nil);
    return;
  }
  if (inSampleRate <= 0 || inNumSamples <= 0) {
    reject(@"LANGUAGE_ID_AUDIO_BUFFER_EMPTY",
           [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioInId],
           nil);
    return;
  }

  std::vector<SegRecord> inputSegments;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto itIn = g_seg_offline.find(segmentsInIdStr);
    if (itIn == g_seg_offline.end() || !itIn->second) {
      reject(@"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND",
             [NSString stringWithFormat:@"Offline segment buffer not found: %@", segmentsInId],
             nil);
      return;
    }
    inputSegments = itIn->second->segments;

    auto itOut = g_seg_offline.find(segmentsOutIdStr);
    if (itOut == g_seg_offline.end() || !itOut->second) {
      reject(@"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND",
             [NSString stringWithFormat:@"Offline segment buffer not found: %@", segmentsOutId],
             nil);
      return;
    }
    if (!itOut->second->segments.empty()) {
      reject(@"LANGUAGE_ID_INVALID_ARGUMENT",
             [NSString stringWithFormat:@"segmentsOut must be an empty offline segment buffer: %@", segmentsOutId],
             nil);
      return;
    }
  }

  dispatch_async(LanguageIdSerialQueue(), ^{
    @try {
      std::vector<SegRecord> speechSpans;
      speechSpans.reserve(inputSegments.size());
      for (const auto &seg : inputSegments) {
        if (seg.kind == "speech" && seg.endSample > seg.startSample) {
          speechSpans.push_back(seg);
        }
      }

      if (speechSpans.empty()) {
        {
          std::lock_guard<std::mutex> lock(g_seg_mutex);
          auto itOut = g_seg_offline.find(segmentsOutIdStr);
          if (itOut != g_seg_offline.end() && itOut->second) {
            itOut->second->segments.clear();
          }
        }
        resolve(@{
          @"labeledCount": @0,
          @"dominantLanguage": @"",
          @"distribution": @{},
          @"switches": @[],
          @"segments": @[],
        });
        return;
      }

      std::vector<SegRecord> records;
      records.reserve(speechSpans.size());
      NSMutableArray *segmentsArray = [NSMutableArray arrayWithCapacity:speechSpans.size()];
      NSMutableArray *switchesArray = [NSMutableArray array];
      std::unordered_map<std::string, double> durationByLang;
      double totalSpeechDurationMs = 0.0;
      NSString *previousLang = nil;

      for (size_t i = 0; i < speechSpans.size(); ++i) {
        const auto &span = speechSpans[i];
        const int start = std::max(0, span.startSample);
        const int end = std::min(span.endSample, inNumSamples);
        const int frameCount = std::max(0, end - start);

        std::vector<float> samples;
        std::string sliceErrCode;
        std::string sliceErrMsg;
        if (frameCount > 0) {
          if (!pa_get_offline_samples_slice(
                  audioInIdStr, start, frameCount, &samples, &sliceErrCode, &sliceErrMsg)) {
            NSString *code = sliceErrCode.empty()
                ? @"LANGUAGE_ID_IDENTIFY_FAILED"
                : [NSString stringWithUTF8String:sliceErrCode.c_str()];
            NSString *msg = sliceErrMsg.empty()
                ? @"Failed to read offline audio slice"
                : [NSString stringWithUTF8String:sliceErrMsg.c_str()];
            reject(code, msg, nil);
            return;
          }
        }

        NSString *langStr = @"";
        if (!samples.empty()) {
          SherpaOnnxOfflineStream *stream =
              SherpaOnnxSpokenLanguageIdentificationCreateOfflineStream(state->handle);
          if (stream != nullptr) {
            SherpaOnnxAcceptWaveformOffline(
                stream, inSampleRate, samples.data(), static_cast<int32_t>(samples.size()));
            const SherpaOnnxSpokenLanguageIdentificationResult *result =
                SherpaOnnxSpokenLanguageIdentificationCompute(state->handle, stream);
            SherpaOnnxDestroyOfflineStream(stream);
            if (result != nullptr && result->lang != nullptr) {
              langStr = [NSString stringWithUTF8String:result->lang];
              SherpaOnnxDestroySpokenLanguageIdentificationResult(result);
            }
          }
        }

        const int durationMs = span.durationMs > 0
            ? span.durationMs
            : ((inSampleRate > 0) ? ((span.endSample - span.startSample) * 1000) / inSampleRate : 0);
        const double startTime = inSampleRate > 0 ? static_cast<double>(span.startSample) / inSampleRate : 0.0;
        const double endTime = inSampleRate > 0 ? static_cast<double>(span.endSample) / inSampleRate : 0.0;

        SegRecord r = span;
        r.payloadJson = std::string("{\"source\":\"languageId\",\"lang\":\"") + [langStr UTF8String] + "\"}";
        records.push_back(std::move(r));

        [segmentsArray addObject:@{
          @"segmentIndex": @(i),
          @"startTime": @(startTime),
          @"endTime": @(endTime),
          @"durationMs": @(durationMs),
          @"lang": langStr,
        }];

        if ([langStr length] > 0) {
          std::string lStr = [langStr UTF8String];
          durationByLang[lStr] += durationMs;
          totalSpeechDurationMs += durationMs;

          if (previousLang == nil || ![langStr isEqualToString:previousLang]) {
            [switchesArray addObject:@{
              @"timestamp": @(startTime),
              @"from": previousLang ?: [NSNull null],
              @"to": langStr,
              @"segmentIndex": @(i),
            }];
            previousLang = langStr;
          }
        }
      }

      {
        std::lock_guard<std::mutex> lock(g_seg_mutex);
        auto itOut = g_seg_offline.find(segmentsOutIdStr);
        if (itOut == g_seg_offline.end() || !itOut->second) {
          reject(@"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND",
                 [NSString stringWithFormat:@"Offline segment buffer not found: %@", segmentsOutId],
                 nil);
          return;
        }
        itOut->second->segments = std::move(records);
      }

      std::string dominantLanguage = "";
      double maxDuration = -1.0;
      NSMutableDictionary *distDict = [NSMutableDictionary dictionary];
      if (totalSpeechDurationMs > 0.0) {
        for (const auto &pair : durationByLang) {
          if (pair.second > maxDuration) {
            maxDuration = pair.second;
            dominantLanguage = pair.first;
          }
          const double fraction = std::round((pair.second / totalSpeechDurationMs) * 10000.0) / 10000.0;
          [distDict setObject:@(fraction) forKey:[NSString stringWithUTF8String:pair.first.c_str()]];
        }
      }

      resolve(@{
        @"labeledCount": @(speechSpans.size()),
        @"dominantLanguage": [NSString stringWithUTF8String:dominantLanguage.c_str()],
        @"distribution": distDict,
        @"switches": switchesArray,
        @"segments": segmentsArray,
      });
    } @catch (NSException *exception) {
      reject(@"LANGUAGE_ID_IDENTIFY_FAILED",
             [NSString stringWithFormat:@"Language identification labeling failed: %@", exception.reason],
             nil);
    }
  });
}

@end
