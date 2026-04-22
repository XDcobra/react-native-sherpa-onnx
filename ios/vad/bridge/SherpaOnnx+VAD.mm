#import "../../SherpaOnnx.h"

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../pipeline/VadPipelineWorker.h"

#include <cmath>
#include <mutex>
#include <string>
#include <unordered_map>
#include <optional>
#include <future>

#include "sherpa-onnx-model-detect.h"

namespace {
std::optional<std::string> OptionalUtf8String(NSString *value) {
  if (value == nil || [value length] == 0) {
    return std::nullopt;
  }
  return std::string([value UTF8String]);
}

NSString *VadModelKindToNSString(sherpaonnx::VadModelKind kind) {
  switch (kind) {
    case sherpaonnx::VadModelKind::kSileroVad:
      return @"silero_vad";
    case sherpaonnx::VadModelKind::kTenVad:
      return @"ten_vad";
    default:
      return @"unknown";
  }
}

struct VadInstanceState {
  int sampleRate = 16000;
  double threshold = 0.015;
  int minSpeechDurationMs = 120;
  bool speechDetected = false;
};

struct VadPipelineState {
  std::string instanceId;
  std::shared_ptr<VadPipelineWorker> worker;
  bool running = true;
  bool flushing = false;
  int queueDepth = 0;
  std::string error;
};

std::mutex g_vad_mutex;
std::unordered_map<std::string, VadInstanceState> g_vad_instances;
std::unordered_map<std::string, VadPipelineState> g_vad_pipelines;
std::unordered_map<std::string, std::string> g_vad_instance_to_pipeline;
} // namespace

@implementation SherpaOnnx (VAD)

- (void)detectVadModel:(NSString *)modelDir
             assetName:(NSString *)assetName
             modelType:(NSString *)modelType
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  @try {
    auto modelDirOpt = OptionalUtf8String(modelDir);
    auto assetNameOpt = OptionalUtf8String(assetName);
    const std::string modelTypeStr =
        (modelType != nil && [modelType length] > 0) ? [modelType UTF8String] : "auto";

    sherpaonnx::VadDetectResult result =
        sherpaonnx::DetectVadModel(modelDirOpt, assetNameOpt, modelTypeStr);

    NSMutableDictionary *resultDict = [NSMutableDictionary dictionary];
    resultDict[@"success"] = @(result.ok);
    resultDict[@"isStreaming"] = @(result.isStreaming);
    if (!result.error.empty()) {
      resultDict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()];
    }
    resultDict[@"modelType"] = VadModelKindToNSString(result.selectedKind);

    NSMutableArray *detectedModels = [NSMutableArray array];
    for (const auto &model : result.detectedModels) {
      [detectedModels addObject:@{
        @"type": [NSString stringWithUTF8String:model.type.c_str()] ?: @"",
        @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()] ?: @""
      }];
    }
    resultDict[@"detectedModels"] = detectedModels;

    if (!result.detectionSources.empty()) {
      NSMutableArray *sources = [NSMutableArray array];
      for (const auto source : result.detectionSources) {
        [sources addObject:[NSString stringWithUTF8String:sherpaonnx::DetectionSourceToLiteral(source)]];
      }
      resultDict[@"detectionSources"] = sources;
    }

    if (!result.derivedLanguages.empty()) {
      NSMutableArray *langs = [NSMutableArray array];
      for (const auto &lang : result.derivedLanguages) {
        [langs addObject:[NSString stringWithUTF8String:lang.c_str()]];
      }
      resultDict[@"languages"] = langs;
    }

    if (!result.quantization.empty()) {
      resultDict[@"quantization"] = [NSString stringWithUTF8String:result.quantization.c_str()];
    }

    NSMutableDictionary *paths = [NSMutableDictionary dictionary];
    if (!result.paths.model.empty()) {
      paths[@"model"] = [NSString stringWithUTF8String:result.paths.model.c_str()];
    }
    resultDict[@"paths"] = paths;

    resolve(resultDict);
  } @catch (NSException *exception) {
    reject(@"DETECT_ERROR",
           [NSString stringWithFormat:@"VAD detect failed: %@", exception.reason],
           nil);
  }
}

- (void)initializeVad:(NSString *)instanceId
              options:(NSDictionary *)options
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"VAD_INVALID_ARGUMENT", @"instanceId is required", nil);
    return;
  }
  VadInstanceState state;
  NSNumber *sampleRate = options[@"sampleRate"];
  NSNumber *threshold = options[@"threshold"];
  NSNumber *minSpeechDurationMs = options[@"minSpeechDurationMs"];
  if (sampleRate != nil) state.sampleRate = MAX(1, [sampleRate intValue]);
  if (threshold != nil) state.threshold = MAX(0.0, [threshold doubleValue]);
  if (minSpeechDurationMs != nil) {
    state.minSpeechDurationMs = MAX(0, [minSpeechDurationMs intValue]);
  }
  std::lock_guard<std::mutex> lock(g_vad_mutex);
  g_vad_instances[[instanceId UTF8String]] = state;
  resolve(nil);
}

- (void)startVadPipeline:(NSString *)instanceId
         audioInBufferId:(NSString *)audioInBufferId
      segmentOutBufferId:(NSString *)segmentOutBufferId
                 options:(NSDictionary *)options
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"VAD_INVALID_ARGUMENT", @"instanceId is required", nil);
    return;
  }
  if (audioInBufferId == nil || [audioInBufferId length] == 0 ||
      segmentOutBufferId == nil || [segmentOutBufferId length] == 0) {
    reject(@"VAD_INVALID_ARGUMENT", @"audioInBufferId and segmentOutBufferId are required", nil);
    return;
  }
  if (![audioInBufferId hasPrefix:@"live_"] || ![segmentOutBufferId hasPrefix:@"seg_live_"]) {
    reject(@"VAD_BUFFER_KIND_MISMATCH", @"VAD live pipeline requires live audio + live segment buffers", nil);
    return;
  }

  std::string iid = [instanceId UTF8String];
  std::string aid = [audioInBufferId UTF8String];
  std::string sid = [segmentOutBufferId UTF8String];
  VadInstanceState cfg;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    auto it = g_vad_instances.find(iid);
    if (it == g_vad_instances.end()) {
      reject(@"VAD_MODEL_INIT_FAILED", @"VAD instance not initialized", nil);
      return;
    }
    cfg = it->second;
    auto pit = g_vad_instance_to_pipeline.find(iid);
    if (pit != g_vad_instance_to_pipeline.end()) {
      auto p = g_vad_pipelines.find(pit->second);
      if (p != g_vad_pipelines.end() && p->second.running) {
        reject(@"VAD_PIPELINE_ALREADY_RUNNING", @"VAD pipeline already running for instance", nil);
        return;
      }
      g_vad_pipelines.erase(pit->second);
      g_vad_instance_to_pipeline.erase(pit);
    }
  }

  auto liveAudio = pa_get_live_entry(aid);
  if (!liveAudio) {
    reject(@"VAD_BUFFER_NOT_FOUND", @"Input live audio buffer not found", nil);
    return;
  }
  {
    std::lock_guard<std::mutex> segLock(g_seg_mutex);
    if (g_seg_live.find(sid) == g_seg_live.end()) {
      reject(@"VAD_BUFFER_NOT_FOUND", @"Output live segment buffer not found", nil);
      return;
    }
  }
  const int chunkSize = ([options[@"chunkSize"] respondsToSelector:@selector(intValue)] ? MAX(1, [options[@"chunkSize"] intValue]) : 512);
  auto worker = std::make_shared<VadPipelineWorker>(
    iid,
    liveAudio,
    VadPipelineWorker::Config{
      cfg.sampleRate,
      cfg.threshold,
      cfg.minSpeechDurationMs,
      MAX(0, ([options[@"silenceDurationMs"] respondsToSelector:@selector(intValue)] ? [options[@"silenceDurationMs"] intValue] : 250)),
      chunkSize,
      aid,
      sid
    },
    [weakSelf = self, iid](const std::string &type,
                           const std::unordered_map<std::string, double> &numbers,
                           const std::unordered_map<std::string, std::string> &strings,
                           const std::unordered_map<std::string, bool> &flags) {
      if (!weakSelf) return;
      std::string pid;
      {
        std::lock_guard<std::mutex> lock(g_vad_mutex);
        auto it = g_vad_instance_to_pipeline.find(iid);
        if (it != g_vad_instance_to_pipeline.end()) {
          pid = it->second;
        }
      }
      NSString *pipelineId = [NSString stringWithUTF8String:pid.c_str()];
      NSMutableDictionary *body = [NSMutableDictionary dictionary];
      body[@"type"] = [NSString stringWithUTF8String:type.c_str()];
      body[@"instanceId"] = [NSString stringWithUTF8String:iid.c_str()];
      body[@"pipelineId"] = pipelineId;
      body[@"ts"] = @((double)([[NSDate date] timeIntervalSince1970] * 1000.0));

      for (const auto &it : numbers) {
        body[[NSString stringWithUTF8String:it.first.c_str()]] = @(it.second);
      }
      for (const auto &it : strings) {
        body[[NSString stringWithUTF8String:it.first.c_str()]] = [NSString stringWithUTF8String:it.second.c_str()];
      }
      for (const auto &it : flags) {
        body[[NSString stringWithUTF8String:it.first.c_str()]] = @(it.second);
      }

      dispatch_async(dispatch_get_main_queue(), ^{
        [weakSelf sendEventWithName:@"vadEvent" body:body];
      });
    }
  );

  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    VadPipelineState state;
    state.instanceId = iid;
    state.worker = worker;
    state.running = true;
    g_vad_pipelines[worker->pipelineId] = state;
    g_vad_instance_to_pipeline[iid] = worker->pipelineId;
  }

  worker->start();
  resolve(@{ @"pipelineId": [NSString stringWithUTF8String:worker->pipelineId.c_str()] });
}

- (void)runVadOffline:(NSString *)instanceId
      audioInBufferId:(NSString *)audioInBufferId
   segmentOutBufferId:(NSString *)segmentOutBufferId
              options:(NSDictionary *)options
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  (void)options;
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"VAD_INVALID_ARGUMENT", @"instanceId is required", nil);
    return;
  }
  if (![audioInBufferId hasPrefix:@"off_"]) {
    reject(@"VAD_BUFFER_KIND_MISMATCH", @"runVadOffline expects an offline audio buffer", nil);
    return;
  }

  std::string iid = [instanceId UTF8String];
  VadInstanceState cfg;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    auto it = g_vad_instances.find(iid);
    if (it == g_vad_instances.end()) {
      reject(@"VAD_MODEL_INIT_FAILED", @"VAD instance not initialized", nil);
      return;
    }
    cfg = it->second;
  }

  std::vector<float> samples;
  int sampleRate = 0;
  if (!pa_read_offline_samples([audioInBufferId UTF8String], &samples, &sampleRate)) {
    reject(@"VAD_BUFFER_NOT_FOUND", @"Offline audio buffer not found", nil);
    return;
  }
  if (sampleRate > 0) cfg.sampleRate = sampleRate;
  const int chunkSize = 512;
  bool inSpeech = false;
  int segStart = 0;
  int segmentCount = 0;
  int64_t speechDurationMs = 0;
  std::vector<SegRecord> records;
  for (int i = 0; i < (int)samples.size(); i += chunkSize) {
    int end = std::min(i + chunkSize, (int)samples.size());
    double energy = 0.0;
    for (int j = i; j < end; ++j) energy += std::fabs(samples[j]);
    energy /= std::max(1, end - i);
    bool speech = energy >= cfg.threshold;
    if (speech && !inSpeech) {
      inSpeech = true;
      segStart = i;
    } else if (!speech && inSpeech) {
      int durMs = ((end - segStart) * 1000) / std::max(1, cfg.sampleRate);
      if (durMs >= cfg.minSpeechDurationMs) {
        SegRecord r;
        r.id = "seg_off_" + std::to_string(segStart) + "_" + std::to_string(end);
        r.kind = "speech";
        r.sourceAudioBufferId = [audioInBufferId UTF8String];
        r.startSample = segStart;
        r.endSample = end;
        r.sampleRate = cfg.sampleRate;
        r.durationMs = durMs;
        r.hasConfidence = true;
        r.confidence = 1.0;
        r.payloadJson = "{\"engine\":\"vad\"}";
        records.push_back(r);
        segmentCount++;
        speechDurationMs += durMs;
      }
      inSpeech = false;
    }
  }

  if (inSpeech) {
    int end = (int)samples.size();
    int durMs = ((end - segStart) * 1000) / std::max(1, cfg.sampleRate);
    if (durMs >= cfg.minSpeechDurationMs) {
      SegRecord r;
      r.id = "seg_off_" + std::to_string(segStart) + "_" + std::to_string(end);
      r.kind = "speech";
      r.sourceAudioBufferId = [audioInBufferId UTF8String];
      r.startSample = segStart;
      r.endSample = end;
      r.sampleRate = cfg.sampleRate;
      r.durationMs = durMs;
      r.hasConfidence = true;
      r.confidence = 1.0;
      r.payloadJson = "{\"engine\":\"vad\"}";
      records.push_back(r);
      segmentCount++;
      speechDurationMs += durMs;
    }
  }

  std::string outId = [segmentOutBufferId UTF8String];
  if ([segmentOutBufferId hasPrefix:@"seg_off_"]) {
    {
      std::lock_guard<std::mutex> lock(g_seg_mutex);
      auto it = g_seg_offline.find(outId);
      if (it != g_seg_offline.end()) {
        it->second->segments = records;
        resolve(@{
          @"chunksProcessed": @((double)ceil((double)samples.size() / (double)chunkSize)),
          @"unitsRead": @((double)samples.size()),
          @"unitsWritten": @((double)segmentCount),
          @"segmentCount": @((double)segmentCount),
          @"speechDurationMs": @((double)speechDurationMs)
        });
        return;
      }
    }
    reject(@"VAD_BUFFER_NOT_FOUND", @"Output offline segment buffer not found", nil);
    return;
  }

  if ([segmentOutBufferId hasPrefix:@"seg_live_"]) {
    for (const auto &record : records) {
      std::string segId;
      int segIndex = -1;
      std::string err;
      const bool ok = seg_live_append_segment(
        outId,
        record.kind,
        record.sourceAudioBufferId,
        record.startSample,
        record.endSample,
        record.sampleRate,
        record.durationMs,
        record.hasConfidence,
        record.confidence,
        record.payloadJson,
        &segId,
        &segIndex,
        &err
      );
      if (!ok) {
        reject(@"VAD_BUFFER_KIND_MISMATCH",
               [NSString stringWithUTF8String:err.empty() ? "Failed to append VAD segments to live segment buffer" : err.c_str()],
               nil);
        return;
      }
    }
    resolve(@{
      @"chunksProcessed": @((double)ceil((double)samples.size() / (double)chunkSize)),
      @"unitsRead": @((double)samples.size()),
      @"unitsWritten": @((double)segmentCount),
      @"segmentCount": @((double)segmentCount),
      @"speechDurationMs": @((double)speechDurationMs)
    });
    return;
  }

  reject(@"VAD_BUFFER_KIND_MISMATCH", @"runVadOffline expects seg_off_* or seg_live_* segment output buffer", nil);
}

- (void)flushVad:(NSString *)pipelineId
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  std::string pid = pipelineId ? [pipelineId UTF8String] : "";
  std::shared_ptr<VadPipelineWorker> worker;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    auto it = g_vad_pipelines.find(pid);
    if (it == g_vad_pipelines.end()) {
      reject(@"VAD_PIPELINE_NOT_FOUND", @"VAD pipeline not found", nil);
      return;
    }
    worker = it->second.worker;
    it->second.flushing = true;
  }
  if (!worker) {
    reject(@"VAD_PIPELINE_NOT_FOUND", @"VAD worker not found", nil);
    return;
  }
  try {
    auto future = worker->flush();
    future.get();
  } catch (const std::exception &e) {
    {
      std::lock_guard<std::mutex> lock(g_vad_mutex);
      auto it = g_vad_pipelines.find(pid);
      if (it != g_vad_pipelines.end()) it->second.flushing = false;
    }
    reject(@"VAD_INTERNAL_ERROR", [NSString stringWithUTF8String:e.what()], nil);
    return;
  }

  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    auto it = g_vad_pipelines.find(pid);
    if (it != g_vad_pipelines.end()) {
      it->second.flushing = false;
    }
  }
  resolve(nil);
}

- (void)resetVad:(NSString *)pipelineId
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  std::shared_ptr<VadPipelineWorker> worker;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    auto it = g_vad_pipelines.find([pipelineId UTF8String]);
    if (it == g_vad_pipelines.end()) {
      reject(@"VAD_PIPELINE_NOT_FOUND", @"VAD pipeline not found", nil);
      return;
    }
    worker = it->second.worker;
  }
  if (!worker) {
    reject(@"VAD_PIPELINE_NOT_FOUND", @"VAD worker not found", nil);
    return;
  }
  try {
    auto future = worker->reset();
    future.get();
  } catch (const std::exception &e) {
    reject(@"VAD_INTERNAL_ERROR", [NSString stringWithUTF8String:e.what()], nil);
    return;
  }
  resolve(nil);
}

- (void)stopVadPipeline:(NSString *)pipelineId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  std::string pid = [pipelineId UTF8String];
  std::string iid;
  std::shared_ptr<VadPipelineWorker> worker;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    auto it = g_vad_pipelines.find(pid);
    if (it == g_vad_pipelines.end()) {
      reject(@"VAD_PIPELINE_NOT_FOUND", @"VAD pipeline not found", nil);
      return;
    }
    iid = it->second.instanceId;
    worker = it->second.worker;
    it->second.running = false;
  }

  if (worker) {
    worker->stop();
  }
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    g_vad_pipelines.erase(pid);
    auto mapping = g_vad_instance_to_pipeline.find(iid);
    if (mapping != g_vad_instance_to_pipeline.end() && mapping->second == pid) {
      g_vad_instance_to_pipeline.erase(mapping);
    }
  }
  resolve(nil);
}

- (void)getVadPipelineStatus:(NSString *)pipelineId
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  std::shared_ptr<VadPipelineWorker> worker;
  bool isFlushing = false;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    auto it = g_vad_pipelines.find([pipelineId UTF8String]);
    if (it == g_vad_pipelines.end()) {
      reject(@"VAD_PIPELINE_NOT_FOUND", @"VAD pipeline not found", nil);
      return;
    }
    worker = it->second.worker;
    isFlushing = it->second.flushing;
  }
  if (!worker) {
    reject(@"VAD_PIPELINE_NOT_FOUND", @"VAD worker not found", nil);
    return;
  }
  StreamingPipelineStatus status = worker->getStatus();
  resolve(@{
    @"pipelineId": pipelineId,
    @"isRunning": @(status.isRunning),
    @"isFlushing": @(isFlushing),
    @"queueDepth": @(worker->queueDepthNow()),
    @"chunksProcessed": @((double)status.chunksProcessed),
    @"unitsRead": @((double)status.unitsRead),
    @"unitsWritten": @((double)status.unitsWritten),
    @"error": status.error.empty() ? [NSNull null] : [NSString stringWithUTF8String:status.error.c_str()]
  });
}

- (void)isVadSpeechDetected:(NSString *)instanceId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  std::string iid = [instanceId UTF8String];
  std::shared_ptr<VadPipelineWorker> worker;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    auto it = g_vad_instances.find(iid);
    if (it == g_vad_instances.end()) {
      reject(@"VAD_MODEL_INIT_FAILED", @"VAD instance not initialized", nil);
      return;
    }
    auto pit = g_vad_instance_to_pipeline.find(iid);
    if (pit != g_vad_instance_to_pipeline.end()) {
      auto p = g_vad_pipelines.find(pit->second);
      if (p != g_vad_pipelines.end()) {
        worker = p->second.worker;
      }
    }
  }
  if (worker) {
    resolve(@(worker->isSpeechDetectedNow()));
    return;
  }
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    auto it = g_vad_instances.find(iid);
    if (it == g_vad_instances.end()) {
      reject(@"VAD_MODEL_INIT_FAILED", @"VAD instance not initialized", nil);
      return;
    }
    resolve(@(it->second.speechDetected));
  }
}

- (void)unloadVad:(NSString *)instanceId
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  std::string iid = [instanceId UTF8String];
  std::vector<std::shared_ptr<VadPipelineWorker>> workersToStop;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    g_vad_instances.erase(iid);
    auto pit = g_vad_instance_to_pipeline.find(iid);
    if (pit != g_vad_instance_to_pipeline.end()) {
      auto it = g_vad_pipelines.find(pit->second);
      if (it != g_vad_pipelines.end()) {
        if (it->second.worker) workersToStop.push_back(it->second.worker);
      }
      g_vad_instance_to_pipeline.erase(pit);
    }
    for (auto it = g_vad_pipelines.begin(); it != g_vad_pipelines.end();) {
      if (it->second.instanceId == iid) {
        if (it->second.worker) workersToStop.push_back(it->second.worker);
        it = g_vad_pipelines.erase(it);
      } else {
        ++it;
      }
    }
  }
  for (auto &w : workersToStop) {
    if (w) w->stop();
  }
  resolve(nil);
}

@end
