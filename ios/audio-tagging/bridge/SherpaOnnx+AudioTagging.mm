#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../core/AudioTaggingBridgeState.h"

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-path-fill.h"
#include "sherpa-onnx-validate-audio-tagging.h"

#include <chrono>
#include <cmath>
#include <cstring>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace {

dispatch_queue_t AudioTaggingSerialQueue() {
  static dispatch_queue_t queue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    queue = dispatch_queue_create("com.sherpaonnx.audiotagging", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

std::optional<std::string> OptionalUtf8(NSString *value) {
  if (value == nil || [value length] == 0) return std::nullopt;
  return std::string([value UTF8String]);
}

NSString *KindToNSString(sherpaonnx::AudioTaggingModelKind kind) {
  switch (kind) {
    case sherpaonnx::AudioTaggingModelKind::kCed:
      return @"ced";
    case sherpaonnx::AudioTaggingModelKind::kZipformer:
      return @"zipformer";
    default:
      return @"unknown";
  }
}

sherpaonnx::AudioTaggingModelKind ParseKind(const std::string &modelType) {
  if (modelType == "ced") return sherpaonnx::AudioTaggingModelKind::kCed;
  if (modelType == "zipformer") return sherpaonnx::AudioTaggingModelKind::kZipformer;
  return sherpaonnx::AudioTaggingModelKind::kUnknown;
}

void FillPathsFromDict(NSDictionary *dict, sherpaonnx::AudioTaggingModelPaths &paths) {
  if (![dict isKindOfClass:[NSDictionary class]]) return;
  std::map<std::string, std::string> pathMap;
  for (NSString *key in dict) {
    id value = dict[key];
    if ([value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0) {
      pathMap[std::string([key UTF8String])] = std::string([(NSString *)value UTF8String]);
    }
  }
  sherpaonnx::FillAudioTaggingModelPathsFromStringMap(pathMap, paths);
}

}  // namespace

@implementation SherpaOnnx (AudioTagging)

- (void)initializeAudioTagging:(NSString *)instanceId
                       options:(JS::NativeSherpaOnnx::AudioTaggingInitBridgeOptions &)options
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"AUDIO_TAGGING_INIT_ERROR", @"instanceId is required", nil);
    return;
  }

  NSString *initMode = options.initMode();
  if (initMode == nil || [initMode length] == 0) {
    initMode = @"auto";
  }
  const bool isCustomInit = [initMode isEqualToString:@"custom"];
  const std::string instanceIdStr = [instanceId UTF8String];

  const int32_t topK = options.topK().has_value()
      ? std::max<int32_t>(1, static_cast<int32_t>(options.topK().value()))
      : 5;
  const int32_t numThreads = options.numThreads().has_value()
      ? std::max<int32_t>(1, static_cast<int32_t>(options.numThreads().value()))
      : 1;
  const bool debug = options.debug().has_value() ? options.debug().value() : false;
  std::string provider = "cpu";
  if (options.provider() != nil && [options.provider() length] > 0) {
    provider = [options.provider() UTF8String];
  }

  std::string modelTypeStr = "auto";
  if (options.modelType() != nil && [options.modelType() length] > 0) {
    modelTypeStr = [options.modelType() UTF8String];
  }

  std::string modelPath;
  std::string labelsPath;
  std::string resolvedModelType;

  if (isCustomInit) {
    if (modelTypeStr.empty() || modelTypeStr == "auto") {
      reject(@"AUDIO_TAGGING_INIT_ERROR",
             @"custom init requires a concrete modelType (ced|zipformer)", nil);
      return;
    }
    const auto kind = ParseKind(modelTypeStr);
    if (kind == sherpaonnx::AudioTaggingModelKind::kUnknown) {
      reject(@"AUDIO_TAGGING_INIT_ERROR",
             [NSString stringWithFormat:@"Unsupported audio tagging model type: %s",
                                        modelTypeStr.c_str()],
             nil);
      return;
    }
    id pathsRaw = options.modelPaths();
    NSDictionary *pathsDict =
        [pathsRaw isKindOfClass:[NSDictionary class]] ? (NSDictionary *)pathsRaw : nil;
    if (pathsDict == nil || pathsDict.count == 0) {
      reject(@"AUDIO_TAGGING_INIT_ERROR", @"modelPaths is required for initMode custom", nil);
      return;
    }
    sherpaonnx::AudioTaggingModelPaths paths;
    FillPathsFromDict(pathsDict, paths);
    auto validation = sherpaonnx::ValidateAudioTaggingPaths(kind, paths, "custom");
    if (!validation.ok) {
      NSString *msg = validation.error.empty()
          ? @"Invalid custom audio tagging model paths"
          : [NSString stringWithUTF8String:validation.error.c_str()];
      reject(@"AUDIO_TAGGING_INIT_ERROR", msg, nil);
      return;
    }
    modelPath = paths.model;
    labelsPath = paths.labels;
    resolvedModelType = modelTypeStr;
  } else {
    NSString *modelDir = options.modelDir();
    if (modelDir == nil || [modelDir length] == 0) {
      reject(@"AUDIO_TAGGING_INIT_ERROR", @"modelDir is required for initMode auto", nil);
      return;
    }
    std::string quantStr;
    if (options.quantization() != nil && [options.quantization() length] > 0) {
      quantStr = [options.quantization() UTF8String];
    }
    const auto detect = sherpaonnx::DetectAudioTaggingModel(
        OptionalUtf8(modelDir),
        std::nullopt,
        modelTypeStr,
        quantStr);
    if (!detect.ok) {
      NSString *msg = detect.error.empty()
          ? @"Failed to detect audio tagging model"
          : [NSString stringWithUTF8String:detect.error.c_str()];
      reject(@"AUDIO_TAGGING_INIT_ERROR", msg, nil);
      return;
    }
    if (detect.selectedKind == sherpaonnx::AudioTaggingModelKind::kUnknown) {
      reject(@"AUDIO_TAGGING_INIT_ERROR", @"Detected unsupported audio tagging model type", nil);
      return;
    }
    modelPath = detect.paths.model;
    labelsPath = detect.paths.labels;
    resolvedModelType = [KindToNSString(detect.selectedKind) UTF8String];
  }

  if (modelPath.empty() || labelsPath.empty()) {
    reject(@"AUDIO_TAGGING_INIT_ERROR", @"model and labels paths are required", nil);
    return;
  }

  const auto kind = ParseKind(resolvedModelType);

  dispatch_async(AudioTaggingSerialQueue(), ^{
    @try {
      auto state = std::make_shared<sherpaonnx::audio_tagging::bridge::AudioTaggingInstanceState>();
      state->defaultTopK = topK;
      state->numThreads = numThreads;
      state->providerStorage = provider;
      state->provider = state->providerStorage;
      state->modelType = resolvedModelType;
      state->modelPath = modelPath;
      state->labelsPath = labelsPath;

      SherpaOnnxAudioTaggingConfig config;
      std::memset(&config, 0, sizeof(config));
      config.model.num_threads = numThreads;
      config.model.debug = debug ? 1 : 0;
      config.model.provider = state->providerStorage.c_str();
      config.labels = state->labelsPath.c_str();
      config.top_k = topK;

      if (kind == sherpaonnx::AudioTaggingModelKind::kCed) {
        config.model.ced = state->modelPath.c_str();
      } else {
        config.model.zipformer.model = state->modelPath.c_str();
      }

      RCTLogInfo(@"[SherpaOnnx:audioTagging] init branch=%@ instanceId=%@ modelType=%@ topK=%d model=%s",
                 initMode, instanceId,
                 [NSString stringWithUTF8String:resolvedModelType.c_str()],
                 (int)topK, state->modelPath.c_str());

      const SherpaOnnxAudioTagging *handle = SherpaOnnxCreateAudioTagging(&config);
      if (handle == nullptr) {
        reject(@"AUDIO_TAGGING_INIT_ERROR",
               @"Failed to create native SherpaOnnxAudioTagging instance",
               nil);
        return;
      }
      state->handle = handle;

      sherpaonnx::audio_tagging::bridge::RemoveAudioTagging(instanceIdStr);
      {
        std::lock_guard<std::mutex> lock(
            sherpaonnx::audio_tagging::bridge::g_audio_tagging_mutex);
        sherpaonnx::audio_tagging::bridge::g_audio_tagging_instances[instanceIdStr] = state;
      }

      resolve(@{
        @"success": @YES,
        @"modelType": [NSString stringWithUTF8String:resolvedModelType.c_str()] ?: @"unknown",
      });
    } @catch (NSException *exception) {
      reject(@"AUDIO_TAGGING_INIT_ERROR",
             [NSString stringWithFormat:@"Audio tagging init failed: %@", exception.reason],
             nil);
    }
  });
}

- (void)tagAudioOffline:(NSString *)instanceId
          audioBufferId:(NSString *)audioBufferId
                   topK:(NSNumber *)topK
            startSample:(NSNumber *)startSample
              endSample:(NSNumber *)endSample
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"AUDIO_TAGGING_TAG_FAILED", @"instanceId is required", nil);
    return;
  }
  if (audioBufferId == nil || [audioBufferId length] == 0) {
    reject(@"AUDIO_TAGGING_BUFFER_NOT_FOUND", @"audioBufferId is required", nil);
    return;
  }

  const bool hasStart = startSample != nil;
  const bool hasEnd = endSample != nil;
  if (hasStart != hasEnd) {
    reject(@"AUDIO_TAGGING_INVALID_ARGUMENT",
           @"startSample and endSample must both be provided or both omitted",
           nil);
    return;
  }

  const std::string instanceIdStr = [instanceId UTF8String];
  const std::string audioInId = [audioBufferId UTF8String];

  if (audioInId.find("off_") != 0) {
    reject(@"AUDIO_TAGGING_INVALID_ARGUMENT",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got: %@", audioBufferId],
           nil);
    return;
  }

  auto state = sherpaonnx::audio_tagging::bridge::LookupAudioTagging(instanceIdStr);
  if (!state || state->handle == nullptr) {
    reject(@"AUDIO_TAGGING_NOT_INITIALIZED",
           [NSString stringWithFormat:@"Audio tagging instance not found: %@", instanceId],
           nil);
    return;
  }

  int inSampleRate = 0;
  int inNumSamples = 0;
  std::string errCode;
  std::string errMsg;
  if (!pa_get_offline_metadata(audioInId, &inSampleRate, &inNumSamples, &errCode, &errMsg)) {
    reject(@"AUDIO_TAGGING_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioBufferId],
           nil);
    return;
  }
  if (inSampleRate <= 0 || inNumSamples <= 0) {
    reject(@"AUDIO_TAGGING_BUFFER_EMPTY",
           [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioBufferId],
           nil);
    return;
  }

  const int32_t effectiveTopK = topK != nil
      ? std::max<int32_t>(1, static_cast<int32_t>([topK intValue]))
      : state->defaultTopK;

  dispatch_async(AudioTaggingSerialQueue(), ^{
    @try {
      std::vector<float> samples;
      int sampleRate = inSampleRate;

      if (!hasStart) {
        if (!pa_read_offline_samples(audioInId, &samples, &sampleRate) || samples.empty()) {
          reject(@"AUDIO_TAGGING_BUFFER_EMPTY",
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
            @"events": @[],
            @"audioDuration": @(0.0),
            @"elapsedMs": @(0.0),
            @"topK": @(effectiveTopK),
          });
          return;
        }
        std::string sliceErrCode;
        std::string sliceErrMsg;
        if (!pa_get_offline_samples_slice(
                audioInId, start, frameCount, &samples, &sliceErrCode, &sliceErrMsg)) {
          NSString *code = sliceErrCode.empty()
              ? @"AUDIO_TAGGING_TAG_FAILED"
              : [NSString stringWithUTF8String:sliceErrCode.c_str()];
          NSString *msg = sliceErrMsg.empty()
              ? @"Failed to read offline audio slice"
              : [NSString stringWithUTF8String:sliceErrMsg.c_str()];
          reject(code, msg, nil);
          return;
        }
        RCTLogInfo(@"[SherpaOnnx:audioTagging] tagOffline slice instanceId=%@ bufferId=%@ startSample=%d endSample=%d frameCount=%d",
                   instanceId, audioBufferId, start, end, frameCount);
      }

      const auto t0 = std::chrono::steady_clock::now();
      const double audioDuration = (sampleRate > 0)
          ? static_cast<double>(samples.size()) / static_cast<double>(sampleRate)
          : 0.0;

      RCTLogInfo(@"[SherpaOnnx:audioTagging] tagOffline instanceId=%@ bufferId=%@ sampleRate=%d numSamples=%zu topK=%d",
                 instanceId, audioBufferId, sampleRate, samples.size(), (int)effectiveTopK);

      const SherpaOnnxOfflineStream *stream =
          SherpaOnnxAudioTaggingCreateOfflineStream(state->handle);
      if (stream == nullptr) {
        reject(@"AUDIO_TAGGING_TAG_FAILED", @"Failed to create offline stream", nil);
        return;
      }

      SherpaOnnxAcceptWaveformOffline(
          stream,
          sampleRate,
          samples.data(),
          static_cast<int32_t>(samples.size()));

      const SherpaOnnxAudioEvent *const *results =
          SherpaOnnxAudioTaggingCompute(state->handle, stream, effectiveTopK);

      NSMutableArray *events = [NSMutableArray array];
      if (results != nullptr) {
        for (int32_t i = 0; results[i] != nullptr; ++i) {
          const SherpaOnnxAudioEvent *ev = results[i];
          [events addObject:@{
            @"name": ev->name != nullptr
                ? [NSString stringWithUTF8String:ev->name]
                : @"",
            @"index": @(ev->index),
            @"prob": @(ev->prob),
          }];
        }
        SherpaOnnxAudioTaggingFreeResults(results);
      }
      SherpaOnnxDestroyOfflineStream(stream);

      const auto t1 = std::chrono::steady_clock::now();
      const double elapsedMs =
          std::chrono::duration<double, std::milli>(t1 - t0).count();

      RCTLogInfo(@"[SherpaOnnx:audioTagging] tagOffline done instanceId=%@ eventCount=%lu elapsedMs=%.1f",
                 instanceId, (unsigned long)events.count, elapsedMs);

      resolve(@{
        @"events": events,
        @"audioDuration": @(audioDuration),
        @"elapsedMs": @(elapsedMs),
        @"topK": @(effectiveTopK),
      });
    } @catch (NSException *exception) {
      reject(@"AUDIO_TAGGING_TAG_FAILED",
             [NSString stringWithFormat:@"Audio tagging failed: %@", exception.reason],
             nil);
    }
  });
}

- (void)unloadAudioTagging:(NSString *)instanceId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }
  const std::string instanceIdStr = [instanceId UTF8String];
  dispatch_async(AudioTaggingSerialQueue(), ^{
    sherpaonnx::audio_tagging::bridge::RemoveAudioTagging(instanceIdStr);
    resolve(nil);
  });
}

@end
