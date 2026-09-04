#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "sherpa-onnx-diarization-wrapper.h"
#include "../core/DiarizationBridgeState.h"

#include <algorithm>
#include <cmath>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace {

std::optional<std::string> OptionalUtf8String(NSString *value) {
  if (value == nil || [value length] == 0) {
    return std::nullopt;
  }
  return std::string([value UTF8String]);
}

dispatch_queue_t DiarizationSerialQueue() {
  static dispatch_queue_t queue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    queue = dispatch_queue_create("com.sherpaonnx.diarization", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

float OptFloat(std::optional<double> value, float fallback) {
  if (!value.has_value()) return fallback;
  return static_cast<float>(value.value());
}

int32_t OptInt32(std::optional<double> value, int32_t fallback) {
  if (!value.has_value()) return fallback;
  return static_cast<int32_t>(value.value());
}

NSDictionary *ProcessResultToDict(const sherpaonnx::DiarizationProcessResult &result) {
  NSMutableArray *segments = [NSMutableArray arrayWithCapacity:result.segments.size()];
  for (const auto &seg : result.segments) {
    [segments addObject:@{
      @"start": @(seg.start),
      @"end": @(seg.end),
      @"speaker": @(seg.speaker),
    }];
  }

  NSMutableDictionary *out = [@{
    @"success": @(result.success),
    @"segments": segments,
    @"numSpeakers": @(result.numSpeakers),
    @"sampleRate": @(result.sampleRate),
  } mutableCopy];

  if (!result.error.empty()) {
    out[@"error"] = [NSString stringWithUTF8String:result.error.c_str()];
  }
  if (!result.errorCode.empty()) {
    out[@"errorCode"] = [NSString stringWithUTF8String:result.errorCode.c_str()];
  }
  if (!result.speakersPerFrame.empty()) {
    NSMutableArray *spf = [NSMutableArray arrayWithCapacity:result.speakersPerFrame.size()];
    for (int32_t v : result.speakersPerFrame) {
      [spf addObject:@(v)];
    }
    out[@"speakersPerFrame"] = spf;
  }
  return out;
}

/** Product diarize path: segments already written to segmentsOut; omit timeline array. */
NSDictionary *ProcessResultToDictWritten(
    const sherpaonnx::DiarizationProcessResult &result,
    NSUInteger segmentCount,
    int sampleRate) {
  NSMutableDictionary *out = [@{
    @"success": @(result.success),
    @"segments": @[],
    @"segmentCount": @(segmentCount),
    @"numSpeakers": @(result.numSpeakers),
    @"sampleRate": @(sampleRate),
  } mutableCopy];

  if (!result.error.empty()) {
    out[@"error"] = [NSString stringWithUTF8String:result.error.c_str()];
  }
  if (!result.errorCode.empty()) {
    out[@"errorCode"] = [NSString stringWithUTF8String:result.errorCode.c_str()];
  }
  if (!result.speakersPerFrame.empty()) {
    NSMutableArray *spf = [NSMutableArray arrayWithCapacity:result.speakersPerFrame.size()];
    for (int32_t v : result.speakersPerFrame) {
      [spf addObject:@(v)];
    }
    out[@"speakersPerFrame"] = spf;
  }
  return out;
}

NSString *RejectCodeForProcess(const sherpaonnx::DiarizationProcessResult &result) {
  if (!result.errorCode.empty()) {
    return [NSString stringWithUTF8String:result.errorCode.c_str()];
  }
  return @"DIARIZATION_ERROR";
}

}  // namespace

@implementation SherpaOnnx (DiarizationOffline)

- (void)initializeDiarization:(NSString *)instanceId
                      options:(JS::NativeSherpaOnnx::DiarizationInitBridgeOptions &)options
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"DIARIZATION_INIT_ERROR", @"instanceId is required", nil);
    return;
  }

  NSString *segmentationModel = options.segmentationModel();
  NSString *embeddingModel = options.embeddingModel();
  if (segmentationModel == nil || [segmentationModel length] == 0 ||
      embeddingModel == nil || [embeddingModel length] == 0) {
    reject(@"DIARIZATION_INIT_ERROR",
           @"segmentationModel and embeddingModel are required",
           nil);
    return;
  }

  const std::string instanceIdStr = [instanceId UTF8String];
  const float windowShiftRatio = OptFloat(options.windowShiftRatio(), 0.1f);
  const int32_t numClusters = OptInt32(options.numClusters(), -1);
  const float threshold = OptFloat(options.threshold(), 0.5f);
  const float minDurationOn = OptFloat(options.minDurationOn(), 0.3f);
  const float minDurationOff = OptFloat(options.minDurationOff(), 0.5f);
  const int32_t numThreads = std::max(1, OptInt32(options.numThreads(), 1));
  const auto provider = OptionalUtf8String(options.provider());
  bool debug = false;
  auto debugOpt = options.debug();
  if (debugOpt.has_value()) {
    debug = debugOpt.value();
  }

  dispatch_async(DiarizationSerialQueue(), ^{
    @try {
      std::lock_guard<std::mutex> lock(sherpaonnx::diarization::bridge::g_diarization_mutex);
      // Replace the map entry so in-flight shared_ptrs keep the old wrapper.
      auto inst = std::make_shared<sherpaonnx::DiarizationWrapper>();

      sherpaonnx::DiarizationInitializeResult result = inst->initialize(
          std::string([segmentationModel UTF8String]),
          std::string([embeddingModel UTF8String]),
          windowShiftRatio,
          numClusters,
          threshold,
          minDurationOn,
          minDurationOff,
          numThreads,
          provider,
          debug);

      if (!result.success) {
        sherpaonnx::diarization::bridge::g_diarization_instances.erase(instanceIdStr);
        NSString *errorMsg = result.error.empty()
            ? @"Failed to initialize diarization"
            : [NSString stringWithUTF8String:result.error.c_str()];
        NSString *errorCode = result.errorCode.empty()
            ? @"DIARIZATION_INIT_ERROR"
            : [NSString stringWithUTF8String:result.errorCode.c_str()];
        RCTLogWarn(@"[SherpaOnnxDiarization] initializeDiarization failed: %@", errorMsg);
        reject(errorCode, errorMsg, nil);
        return;
      }

      sherpaonnx::diarization::bridge::g_diarization_instances[instanceIdStr] =
          std::move(inst);

      NSMutableDictionary *out = [@{
        @"success": @YES,
        @"sampleRate": @(result.sampleRate),
      } mutableCopy];
      if (!result.error.empty()) {
        out[@"error"] = [NSString stringWithUTF8String:result.error.c_str()];
      }
      if (!result.errorCode.empty()) {
        out[@"errorCode"] = [NSString stringWithUTF8String:result.errorCode.c_str()];
      }
      resolve(out);
    } @catch (NSException *exception) {
      reject(@"DIARIZATION_INIT_ERROR",
             [NSString stringWithFormat:@"Diarization init failed: %@", exception.reason],
             nil);
    }
  });
}

- (void)diarizeOffline:(NSString *)instanceId
       audioInBufferId:(NSString *)audioInBufferId
  segmentsOutBufferId:(NSString *)segmentsOutBufferId
        includeOverlap:(BOOL)includeOverlap
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"DIARIZATION_ERROR", @"instanceId is required", nil);
    return;
  }
  if (audioInBufferId == nil || [audioInBufferId length] == 0) {
    reject(@"DIARIZATION_BUFFER_NOT_FOUND", @"audioInBufferId is required", nil);
    return;
  }
  if (segmentsOutBufferId == nil || [segmentsOutBufferId length] == 0 ||
      ![segmentsOutBufferId hasPrefix:@"seg_off_"]) {
    reject(@"DIARIZATION_ERROR",
           [NSString stringWithFormat:
               @"Expected empty offline segment buffer (seg_off_*) for segmentsOut, got: %@",
               segmentsOutBufferId ?: @"(null)"],
           nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  std::string audioInId = [audioInBufferId UTF8String];
  std::string segmentsOutId = [segmentsOutBufferId UTF8String];
  if (audioInId.find("off_") != 0) {
    reject(@"DIARIZATION_ERROR",
           [NSString stringWithFormat:@"Expected offline audio buffer (off_*) for audioIn, got: %@",
                                      audioInBufferId],
           nil);
    return;
  }

  int inSampleRate = 0;
  int inNumSamples = 0;
  std::string errCode;
  std::string errMsg;
  if (!pa_get_offline_metadata(audioInId, &inSampleRate, &inNumSamples, &errCode, &errMsg)) {
    reject(@"DIARIZATION_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioInBufferId],
           nil);
    return;
  }
  if (inSampleRate <= 0 || inNumSamples <= 0) {
    reject(@"DIARIZATION_ERROR",
           [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioInBufferId],
           nil);
    return;
  }

  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto it = g_seg_offline.find(segmentsOutId);
    if (it == g_seg_offline.end() || !it->second) {
      reject(@"DIARIZATION_BUFFER_NOT_FOUND",
             [NSString stringWithFormat:@"Offline segment buffer not found: %@",
                                        segmentsOutBufferId],
             nil);
      return;
    }
    if (!it->second->segments.empty()) {
      reject(@"DIARIZATION_ERROR",
             @"segmentOut must be an empty offline segment buffer",
             nil);
      return;
    }
  }

  dispatch_async(DiarizationSerialQueue(), ^{
    @try {
      std::vector<float> inputSamples;
      int inputSr = 0;
      if (!pa_read_offline_samples(audioInId, &inputSamples, &inputSr) || inputSamples.empty()) {
        reject(@"DIARIZATION_ERROR",
               [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioInBufferId],
               nil);
        return;
      }

      auto wrapper =
          sherpaonnx::diarization::bridge::LookupDiarization(instanceIdStr);
      if (!wrapper) {
        reject(@"DIARIZATION_NOT_INITIALIZED",
               [NSString stringWithFormat:@"Diarization instance not found: %@", instanceId],
               nil);
        return;
      }

      sherpaonnx::DiarizationProcessResult result =
          wrapper->processMonoSamples(inputSamples, inputSr, includeOverlap ? true : false, {});
      if (!result.success) {
        reject(RejectCodeForProcess(result),
               result.error.empty()
                   ? @"Diarization process failed"
                   : [NSString stringWithUTF8String:result.error.c_str()],
               nil);
        return;
      }

      const int sampleRate =
          result.sampleRate > 0 ? result.sampleRate : inSampleRate;
      std::vector<SegRecord> records;
      records.reserve(result.segments.size());
      for (const auto &seg : result.segments) {
        const int startSample =
            std::max(0, static_cast<int>(std::lround(seg.start * sampleRate)));
        const int endSample =
            std::max(startSample, static_cast<int>(std::lround(seg.end * sampleRate)));
        const int durationMs =
            sampleRate > 0 ? ((endSample - startSample) * 1000) / sampleRate : 0;
        SegRecord r;
        r.id = "seg_off_" + std::to_string(startSample) + "_" + std::to_string(endSample);
        r.kind = "diarization";
        r.sourceAudioBufferId = audioInId;
        r.startSample = startSample;
        r.endSample = endSample;
        r.sampleRate = sampleRate;
        r.durationMs = durationMs;
        r.hasConfidence = false;
        r.payloadJson =
            std::string("{\"source\":\"diarization\",\"speaker\":") +
            std::to_string(seg.speaker) + "}";
        records.push_back(std::move(r));
      }

      {
        std::lock_guard<std::mutex> lock(g_seg_mutex);
        auto it = g_seg_offline.find(segmentsOutId);
        if (it == g_seg_offline.end() || !it->second) {
          reject(@"DIARIZATION_BUFFER_NOT_FOUND",
                 [NSString stringWithFormat:@"Offline segment buffer not found: %@",
                                            segmentsOutBufferId],
                 nil);
          return;
        }
        if (!it->second->segments.empty()) {
          reject(@"DIARIZATION_ERROR",
                 @"segmentOut must be an empty offline segment buffer",
                 nil);
          return;
        }
        it->second->segments = std::move(records);
      }

      resolve(ProcessResultToDictWritten(result, result.segments.size(), sampleRate));
    } @catch (NSException *exception) {
      reject(@"DIARIZATION_ERROR",
             [NSString stringWithFormat:@"Diarization process failed: %@", exception.reason],
             nil);
    }
  });
}

- (void)reclusterDiarization:(NSString *)instanceId
                 numClusters:(double)numClusters
                   threshold:(double)threshold
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"DIARIZATION_ERROR", @"instanceId is required", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  dispatch_async(DiarizationSerialQueue(), ^{
    @try {
      auto wrapper =
          sherpaonnx::diarization::bridge::LookupDiarization(instanceIdStr);
      if (!wrapper) {
        reject(@"DIARIZATION_NOT_INITIALIZED",
               [NSString stringWithFormat:@"Diarization instance not found: %@", instanceId],
               nil);
        return;
      }
      sherpaonnx::DiarizationProcessResult result =
          wrapper->recluster(static_cast<int32_t>(numClusters),
                             static_cast<float>(threshold));
      if (!result.success) {
        reject(RejectCodeForProcess(result),
               result.error.empty()
                   ? @"Diarization recluster failed"
                   : [NSString stringWithUTF8String:result.error.c_str()],
               nil);
        return;
      }
      resolve(ProcessResultToDict(result));
    } @catch (NSException *exception) {
      reject(@"DIARIZATION_ERROR",
             [NSString stringWithFormat:@"Diarization recluster failed: %@", exception.reason],
             nil);
    }
  });
}

- (void)getDiarizationClusterEmbeddings:(NSString *)instanceId
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"DIARIZATION_ERROR", @"instanceId is required", nil);
    return;
  }

  std::string instanceIdStr = [instanceId UTF8String];
  dispatch_async(DiarizationSerialQueue(), ^{
    @try {
      auto wrapper =
          sherpaonnx::diarization::bridge::LookupDiarization(instanceIdStr);
      if (!wrapper) {
        reject(@"DIARIZATION_NOT_INITIALIZED",
               [NSString stringWithFormat:@"Diarization instance not found: %@", instanceId],
               nil);
        return;
      }
      std::vector<sherpaonnx::DiarizationClusterEmbeddingDto> embeddings =
          wrapper->getClusterEmbeddings();

      NSMutableArray *out = [NSMutableArray arrayWithCapacity:embeddings.size()];
      for (const auto &entry : embeddings) {
        NSMutableArray *emb = [NSMutableArray arrayWithCapacity:entry.embedding.size()];
        for (float v : entry.embedding) {
          [emb addObject:@(v)];
        }
        [out addObject:@{
          @"speaker": @(entry.speaker),
          @"embedding": emb,
        }];
      }
      resolve(out);
    } @catch (NSException *exception) {
      reject(@"DIARIZATION_ERROR",
             [NSString stringWithFormat:@"getDiarizationClusterEmbeddings failed: %@",
                                        exception.reason],
             nil);
    }
  });
}

- (void)cancelDiarization:(NSString *)instanceId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }
  const std::string instanceIdStr = [instanceId UTF8String];
  @try {
    auto wrapper =
        sherpaonnx::diarization::bridge::LookupDiarization(instanceIdStr);
    if (wrapper) {
      wrapper->cancel();
    }
    resolve(nil);
  } @catch (NSException *exception) {
    reject(@"DIARIZATION_ERROR",
           [NSString stringWithFormat:@"cancelDiarization failed: %@", exception.reason],
           nil);
  }
}

- (void)unloadDiarization:(NSString *)instanceId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }
  const std::string instanceIdStr = [instanceId UTF8String];
  dispatch_async(DiarizationSerialQueue(), ^{
    @try {
      std::shared_ptr<sherpaonnx::DiarizationWrapper> doomed;
      {
        std::lock_guard<std::mutex> lock(sherpaonnx::diarization::bridge::g_diarization_mutex);
        auto it = sherpaonnx::diarization::bridge::g_diarization_instances.find(instanceIdStr);
        if (it != sherpaonnx::diarization::bridge::g_diarization_instances.end()) {
          if (it->second) {
            it->second->cancel();
          }
          doomed = std::move(it->second);
          sherpaonnx::diarization::bridge::g_diarization_instances.erase(it);
        }
      }
      // Destructor releases when last shared_ptr drops (after in-flight process).
      resolve(nil);
    } @catch (NSException *exception) {
      reject(@"DIARIZATION_ERROR",
             [NSString stringWithFormat:@"unloadDiarization failed: %@", exception.reason],
             nil);
    }
  });
}

@end
