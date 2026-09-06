#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../pipeline/bridge/SherpaOnnx+StreamingPipelineCompletion.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../core/DiarizationBridgeState.h"
#include "../pipeline/DiarizationStreamingPipelineWorker.h"
#include "sherpa-onnx-streaming-diarization-wrapper.h"

#include <chrono>
#include <memory>
#include <string>

namespace {

dispatch_queue_t StreamingDiarizationSerialQueue() {
  static dispatch_queue_t queue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    queue = dispatch_queue_create("com.sherpaonnx.streaming.diarization", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

NSDictionary *FeedResultToDict(const sherpaonnx::StreamingDiarizationFeedResult &result) {
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
  } mutableCopy];

  if (!result.error.empty()) {
    out[@"error"] = [NSString stringWithUTF8String:result.error.c_str()];
  }
  if (!result.errorCode.empty()) {
    out[@"errorCode"] = [NSString stringWithUTF8String:result.errorCode.c_str()];
  }
  return out;
}

} // namespace

@implementation SherpaOnnx (DiarizationStreaming)

- (void)initializeStreamingDiarization:(NSString *)instanceId
                               options:(NSDictionary *)options
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject {
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"DIARIZATION_INIT_ERROR", @"instanceId is required", nil);
    return;
  }

  NSString *modelPath = options[@"model"];
  if (modelPath == nil || [modelPath length] == 0) {
    reject(@"DIARIZATION_INIT_ERROR", @"model path is required", nil);
    return;
  }

  NSString *metadataPath = options[@"metadata"] ?: @"";
  int numThreads = [options[@"numThreads"] intValue] > 0 ? [options[@"numThreads"] intValue] : 1;
  NSString *provider = options[@"provider"] ?: @"cpu";
  bool debug = [options[@"debug"] boolValue];

  float onset = options[@"onset"] ? [options[@"onset"] floatValue] : 0.5f;
  float offset = options[@"offset"] ? [options[@"offset"] floatValue] : 0.5f;
  float padOnset = options[@"padOnset"] ? [options[@"padOnset"] floatValue] : 0.0f;
  float padOffset = options[@"padOffset"] ? [options[@"padOffset"] floatValue] : 0.0f;
  float minDurationOn = options[@"minDurationOn"] ? [options[@"minDurationOn"] floatValue] : 0.0f;
  float minDurationOff = options[@"minDurationOff"] ? [options[@"minDurationOff"] floatValue] : 0.5f;
  int medianWindow = options[@"medianWindow"] ? [options[@"medianWindow"] intValue] : 11;

  dispatch_async(StreamingDiarizationSerialQueue(), ^{
    std::string instId = [instanceId UTF8String];
    auto wrapper = std::make_shared<sherpaonnx::StreamingDiarizationWrapper>();

    auto res = wrapper->initialize(
        [modelPath UTF8String],
        [metadataPath UTF8String],
        numThreads,
        [provider UTF8String],
        debug,
        onset,
        offset,
        padOnset,
        padOffset,
        minDurationOn,
        minDurationOff,
        medianWindow);

    if (!res.success) {
      NSString *err = [NSString stringWithUTF8String:res.error.c_str()];
      NSString *code = [NSString stringWithUTF8String:res.errorCode.c_str()];
      reject(code, err, nil);
      return;
    }

    {
      std::lock_guard<std::mutex> lock(sherpaonnx::diarization::bridge::g_streaming_diarization_mutex);
      sherpaonnx::diarization::bridge::g_streaming_diarization_instances[instId] = wrapper;
    }

    resolve(@{
      @"success": @YES,
      @"sampleRate": @(res.sampleRate),
      @"maxSpeakers": @(res.maxSpeakers),
      @"feedSamples": @(res.feedSamples),
      @"strideSamples": @(res.strideSamples),
      @"latencySeconds": @(res.latencySeconds),
    });
  });
}

- (void)startStreamingDiarizationPipeline:(NSString *)instanceId
                          audioInBufferId:(NSString *)audioInBufferId
                      segmentsOutBufferId:(NSString *)segmentsOutBufferId
                                  options:(NSDictionary *)options
                                  resolve:(RCTPromiseResolveBlock)resolve
                                   reject:(RCTPromiseRejectBlock)reject {
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"DIARIZATION_ERROR", @"instanceId is required", nil);
    return;
  }

  std::string instId = [instanceId UTF8String];
  auto wrapper = sherpaonnx::diarization::bridge::LookupStreamingDiarization(instId);
  if (!wrapper) {
    reject(@"DIARIZATION_ERROR", @"Streaming diarization instance not found", nil);
    return;
  }

  if (audioInBufferId == nil || ![audioInBufferId hasPrefix:@"live_"]) {
    reject(@"DIARIZATION_BUFFER_NOT_FOUND", @"audioInBufferId must be a live audio buffer (live_*)", nil);
    return;
  }
  if (segmentsOutBufferId == nil || ![segmentsOutBufferId hasPrefix:@"seg_live_"]) {
    reject(@"DIARIZATION_BUFFER_NOT_FOUND", @"segmentsOutBufferId must be a live segment buffer (seg_live_*)", nil);
    return;
  }

  std::string audioInIdStr = [audioInBufferId UTF8String];
  std::string segmentsOutIdStr = [segmentsOutBufferId UTF8String];

  auto inEntry = pa_live_get_entry(audioInIdStr);
  if (!inEntry) {
    reject(@"DIARIZATION_BUFFER_NOT_FOUND", @"Live audio buffer not found", nil);
    return;
  }

  DiarizationStreamingPipelineWorker::Config config;
  config.sampleRate = wrapper->getSampleRate();
  config.chunkSize = options[@"chunkSize"] ? [options[@"chunkSize"] intValue] : 4096;
  config.sourceAudioBufferId = audioInIdStr;
  config.segmentOutBufferId = segmentsOutIdStr;
  config.wrapper = wrapper;

  try {
    std::string pipelineId =
        std::string("diar_live_") +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());

    __weak SherpaOnnx *weakSelf = self;
    auto emitEvent = [weakSelf, instId, pipelineId](
        const std::string &type,
        const std::unordered_map<std::string, double> &numeric,
        const std::unordered_map<std::string, std::string> &text,
        const std::unordered_map<std::string, bool> &boolean) {
      SherpaOnnx *strongSelf = weakSelf;
      if (!strongSelf) return;

      NSMutableDictionary *data = [NSMutableDictionary dictionary];
      for (const auto &pair : numeric) {
        data[[NSString stringWithUTF8String:pair.first.c_str()]] = @(pair.second);
      }
      for (const auto &pair : text) {
        data[[NSString stringWithUTF8String:pair.first.c_str()]] =
            [NSString stringWithUTF8String:pair.second.c_str()];
      }
      for (const auto &pair : boolean) {
        data[[NSString stringWithUTF8String:pair.first.c_str()]] = @(pair.second);
      }

      NSDictionary *event = @{
        @"instanceId": [NSString stringWithUTF8String:instId.c_str()],
        @"pipelineId": [NSString stringWithUTF8String:pipelineId.c_str()],
        @"type": [NSString stringWithUTF8String:type.c_str()],
        @"data": data,
      };

      [strongSelf sendEventWithName:@"SherpaOnnxDiarizationEvent" body:event];
    };

    auto worker = std::make_shared<DiarizationStreamingPipelineWorker>(
        instId, inEntry, config, emitEvent);
    worker->pipelineId = pipelineId;

    {
      std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
      g_streaming_pipelines[pipelineId] = worker;
    }

    worker->start();
    so_start_streaming_pipeline_completion_watcher(self, pipelineId, worker);

    resolve(@{ @"pipelineId": [NSString stringWithUTF8String:pipelineId.c_str()] });
  } catch (const std::exception &e) {
    reject(@"DIARIZATION_ERROR", [NSString stringWithUTF8String:e.what()], nil);
  } catch (...) {
    reject(@"DIARIZATION_ERROR", @"Failed to start streaming diarization pipeline", nil);
  }
}

- (void)feedStreamingDiarization:(NSString *)instanceId
                 audioInBufferId:(NSString *)audioInBufferId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject {
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"DIARIZATION_ERROR", @"instanceId is required", nil);
    return;
  }

  std::string instId = [instanceId UTF8String];
  auto wrapper = sherpaonnx::diarization::bridge::LookupStreamingDiarization(instId);
  if (!wrapper) {
    reject(@"DIARIZATION_ERROR", @"Streaming diarization instance not found", nil);
    return;
  }

  if (audioInBufferId == nil || [audioInBufferId length] == 0) {
    reject(@"DIARIZATION_BUFFER_NOT_FOUND", @"audioInBufferId is required", nil);
    return;
  }

  std::string audioInIdStr = [audioInBufferId UTF8String];
  auto offlineEntry = pa_offline_get_entry(audioInIdStr);
  if (!offlineEntry) {
    reject(@"DIARIZATION_BUFFER_NOT_FOUND", @"Audio buffer not found", nil);
    return;
  }

  dispatch_async(StreamingDiarizationSerialQueue(), ^{
    auto res = wrapper->feed(offlineEntry->samples.data(), offlineEntry->samples.size());
    resolve(FeedResultToDict(res));
  });
}

- (void)flushStreamingDiarization:(NSString *)instanceId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject {
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"DIARIZATION_ERROR", @"instanceId is required", nil);
    return;
  }

  std::string instId = [instanceId UTF8String];
  auto wrapper = sherpaonnx::diarization::bridge::LookupStreamingDiarization(instId);
  if (!wrapper) {
    reject(@"DIARIZATION_ERROR", @"Streaming diarization instance not found", nil);
    return;
  }

  dispatch_async(StreamingDiarizationSerialQueue(), ^{
    auto res = wrapper->flush();
    resolve(FeedResultToDict(res));
  });
}

- (void)resetStreamingDiarization:(NSString *)instanceId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject {
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"DIARIZATION_ERROR", @"instanceId is required", nil);
    return;
  }

  std::string instId = [instanceId UTF8String];
  auto wrapper = sherpaonnx::diarization::bridge::LookupStreamingDiarization(instId);
  if (wrapper) {
    wrapper->reset();
  }
  resolve(nil);
}

- (void)releaseStreamingDiarization:(NSString *)instanceId
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject {
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"DIARIZATION_ERROR", @"instanceId is required", nil);
    return;
  }

  std::string instId = [instanceId UTF8String];
  std::shared_ptr<sherpaonnx::StreamingDiarizationWrapper> doomed;
  {
    std::lock_guard<std::mutex> lock(sherpaonnx::diarization::bridge::g_streaming_diarization_mutex);
    auto it = sherpaonnx::diarization::bridge::g_streaming_diarization_instances.find(instId);
    if (it != sherpaonnx::diarization::bridge::g_streaming_diarization_instances.end()) {
      doomed = std::move(it->second);
      sherpaonnx::diarization::bridge::g_streaming_diarization_instances.erase(it);
    }
  }
  if (doomed) {
    doomed->release();
  }
  resolve(nil);
}

@end
