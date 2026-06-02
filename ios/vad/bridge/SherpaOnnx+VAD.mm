#import "../../SherpaOnnx.h"

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../core/VadRuntime.h"
#include "../pipeline/VadPipelineWorker.h"

#include <cmath>
#include <mutex>
#include <string>
#include <unordered_map>
#include <optional>
#include <future>
#include <algorithm>

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
  std::string modelType;
  std::string modelPath;
  int sampleRate = 16000;
  int numThreads = 1;
  std::string provider = "cpu";
  bool debug = false;
  double scoreThreshold = 0.5;
  int minSpeechDurationMs = 250;
  int minSilenceDurationMs = 250;
  int maxSpeechDurationMs = 5000;
  int windowSize = 512;
  bool speechDetected = false;
  std::shared_ptr<VadRuntime> runtime;
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

std::shared_ptr<VadPipelineWorker> DetachPipelineLocked(
  const std::string &pipelineId,
  std::string *instanceIdOut = nullptr
) {
  auto pipelineIt = g_vad_pipelines.find(pipelineId);
  if (pipelineIt == g_vad_pipelines.end()) {
    return nullptr;
  }
  if (instanceIdOut != nullptr) {
    *instanceIdOut = pipelineIt->second.instanceId;
  }
  auto worker = pipelineIt->second.worker;
  g_vad_pipelines.erase(pipelineIt);
  for (auto mapping = g_vad_instance_to_pipeline.begin();
       mapping != g_vad_instance_to_pipeline.end();) {
    if (mapping->second == pipelineId) {
      mapping = g_vad_instance_to_pipeline.erase(mapping);
    } else {
      ++mapping;
    }
  }
  return worker;
}
} // namespace

@implementation SherpaOnnx (VAD)

- (void)detectVadModel:(NSString *)modelDir
             assetName:(NSString * _Nullable)assetName
             modelType:(NSString * _Nullable)modelType
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
  NSString *modelDir = options[@"modelDir"];
  if (modelDir == nil || [modelDir length] == 0) {
    reject(@"VAD_MODEL_INIT_FAILED", @"modelDir is required for VAD initialization", nil);
    return;
  }

  const std::string requestedModelType =
      ([options[@"modelType"] isKindOfClass:[NSString class]] &&
       [options[@"modelType"] length] > 0)
          ? std::string([options[@"modelType"] UTF8String])
          : "auto";

  sherpaonnx::VadDetectResult detect =
      sherpaonnx::DetectVadModel(OptionalUtf8String(modelDir), std::nullopt, requestedModelType);
  if (!detect.ok) {
    const std::string reason = detect.error.empty() ? "Failed to detect VAD model" : detect.error;
    reject(@"VAD_MODEL_INIT_FAILED", [NSString stringWithUTF8String:reason.c_str()], nil);
    return;
  }
  NSString *resolvedModelType = VadModelKindToNSString(detect.selectedKind);
  if (![resolvedModelType isEqualToString:@"silero_vad"] &&
      ![resolvedModelType isEqualToString:@"ten_vad"]) {
    reject(@"VAD_MODEL_INIT_FAILED", @"Unsupported VAD model type", nil);
    return;
  }
  if (detect.paths.model.empty()) {
    reject(@"VAD_MODEL_INIT_FAILED", @"Detected VAD model path is empty", nil);
    return;
  }

  VadInstanceState state;
  state.modelType = [resolvedModelType UTF8String];
  state.modelPath = detect.paths.model;
  if ([options[@"sampleRate"] respondsToSelector:@selector(intValue)]) {
    state.sampleRate = MAX(1, [options[@"sampleRate"] intValue]);
  }
  if ([options[@"numThreads"] respondsToSelector:@selector(intValue)]) {
    state.numThreads = MAX(1, [options[@"numThreads"] intValue]);
  }
  if ([options[@"provider"] isKindOfClass:[NSString class]] &&
      [options[@"provider"] length] > 0) {
    state.provider = std::string([options[@"provider"] UTF8String]);
  }
  if ([options[@"debug"] respondsToSelector:@selector(boolValue)]) {
    state.debug = [options[@"debug"] boolValue];
  }
  if ([options[@"threshold"] respondsToSelector:@selector(doubleValue)]) {
    state.scoreThreshold = MAX(0.0, [options[@"threshold"] doubleValue]);
  }
  if ([options[@"minSpeechDurationMs"] respondsToSelector:@selector(intValue)]) {
    state.minSpeechDurationMs = MAX(0, [options[@"minSpeechDurationMs"] intValue]);
  } else if ([options[@"speechDurationMs"] respondsToSelector:@selector(intValue)]) {
    state.minSpeechDurationMs = MAX(0, [options[@"speechDurationMs"] intValue]);
  }
  if ([options[@"silenceDurationMs"] respondsToSelector:@selector(intValue)]) {
    state.minSilenceDurationMs = MAX(0, [options[@"silenceDurationMs"] intValue]);
  }
  if ([options[@"windowSize"] respondsToSelector:@selector(intValue)]) {
    state.windowSize = MAX(1, [options[@"windowSize"] intValue]);
  } else if ([resolvedModelType isEqualToString:@"ten_vad"]) {
    state.windowSize = 256;
  }
  if ([options[@"maxSpeechDurationS"] respondsToSelector:@selector(doubleValue)]) {
    state.maxSpeechDurationMs =
        MAX(0, (int)llround([options[@"maxSpeechDurationS"] doubleValue] * 1000.0));
  }

  VadRuntimeConfig runtimeCfg;
  runtimeCfg.modelType = state.modelType;
  runtimeCfg.modelPath = state.modelPath;
  runtimeCfg.sampleRate = state.sampleRate;
  runtimeCfg.numThreads = state.numThreads;
  runtimeCfg.provider = state.provider;
  runtimeCfg.debug = state.debug;
  runtimeCfg.scoreThreshold = state.scoreThreshold;
  runtimeCfg.minSpeechDurationMs = state.minSpeechDurationMs;
  runtimeCfg.minSilenceDurationMs = state.minSilenceDurationMs;
  runtimeCfg.maxSpeechDurationMs = state.maxSpeechDurationMs;
  runtimeCfg.windowSize = state.windowSize;
  std::string runtimeErr;
  state.runtime = VadRuntime::Create(runtimeCfg, &runtimeErr);
  if (!state.runtime) {
    reject(
      @"VAD_MODEL_INIT_FAILED",
      [NSString stringWithUTF8String:(runtimeErr.empty() ? "Failed to create iOS VAD runtime" : runtimeErr.c_str())],
      nil
    );
    return;
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
  std::shared_ptr<VadPipelineWorker> staleWorker;
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
      staleWorker = DetachPipelineLocked(pit->second, nullptr);
    }
  }
  if (staleWorker) {
    staleWorker->stop();
  }

  auto liveAudio = pa_get_live_entry(aid);
  if (!liveAudio) {
    if (pa_is_live_invalidated(aid)) {
      reject(@"BUFFER_INVALIDATED", @"Input live audio buffer is invalidated after transfer", nil);
    } else {
      reject(@"VAD_BUFFER_NOT_FOUND", @"Input live audio buffer not found", nil);
    }
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
  if (!cfg.runtime) {
    reject(@"VAD_MODEL_INIT_FAILED", @"VAD runtime is not initialized", nil);
    return;
  }
  auto worker = std::make_shared<VadPipelineWorker>(
    iid,
    liveAudio,
    VadPipelineWorker::Config{
      cfg.sampleRate,
      chunkSize,
      MAX(1, cfg.windowSize),
      aid,
      sid,
      cfg.runtime,
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
  const int frameSize = MAX(1, cfg.windowSize);
  if (!cfg.runtime) {
    reject(@"VAD_MODEL_INIT_FAILED", @"VAD runtime is not initialized", nil);
    return;
  }
  cfg.runtime->Reset();
  int segmentCount = 0;
  int64_t speechDurationMs = 0;
  int chunksProcessed = 0;
  std::vector<SegRecord> records;
  std::vector<float> pending;
  pending.insert(pending.end(), samples.begin(), samples.end());
  auto appendSegments = [&](const std::vector<VadRuntimeSegment> &segments) {
    for (const auto &segment : segments) {
      SegRecord r;
      r.id = "seg_off_" + std::to_string(segment.startSample) + "_" +
             std::to_string(segment.endSample);
      r.kind = "speech";
      r.sourceAudioBufferId = [audioInBufferId UTF8String];
      r.startSample = segment.startSample;
      r.endSample = segment.endSample;
      r.sampleRate = cfg.sampleRate;
      r.durationMs = segment.durationMs;
      r.hasConfidence = true;
      r.confidence = 1.0;
      r.payloadJson = "{\"source\":\"vad\",\"engine\":\"vad\",\"decision\":\"model\"}";
      records.push_back(r);
      segmentCount++;
      speechDurationMs += segment.durationMs;
    }
  };
  while ((int)pending.size() >= frameSize) {
    cfg.runtime->AcceptWaveform(pending.data(), frameSize);
    chunksProcessed += 1;
    appendSegments(cfg.runtime->PopSegments());
    pending.erase(pending.begin(), pending.begin() + frameSize);
  }
  if (!pending.empty()) {
    std::vector<float> tail(frameSize, 0.0f);
    std::copy(pending.begin(), pending.end(), tail.begin());
    cfg.runtime->AcceptWaveform(tail.data(), frameSize);
    chunksProcessed += 1;
    appendSegments(cfg.runtime->PopSegments());
    pending.clear();
  }
  cfg.runtime->Flush();
  const auto finalSegments = cfg.runtime->PopSegments();
  for (const auto &segment : finalSegments) {
    SegRecord r;
    r.id = "seg_off_" + std::to_string(segment.startSample) + "_" +
           std::to_string(segment.endSample);
    r.kind = "speech";
    r.sourceAudioBufferId = [audioInBufferId UTF8String];
    r.startSample = segment.startSample;
    r.endSample = segment.endSample;
    r.sampleRate = cfg.sampleRate;
    r.durationMs = segment.durationMs;
    r.hasConfidence = true;
    r.confidence = 1.0;
    r.payloadJson = "{\"source\":\"vad\",\"engine\":\"vad\",\"decision\":\"model\"}";
    records.push_back(r);
    segmentCount++;
    speechDurationMs += segment.durationMs;
  }

  std::string outId = [segmentOutBufferId UTF8String];
  if ([segmentOutBufferId hasPrefix:@"seg_off_"]) {
    {
      std::lock_guard<std::mutex> lock(g_seg_mutex);
      auto it = g_seg_offline.find(outId);
      if (it != g_seg_offline.end()) {
        it->second->segments = records;
        resolve(@{
          @"chunksProcessed": @((double)chunksProcessed),
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
      @"chunksProcessed": @((double)chunksProcessed),
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
    worker = DetachPipelineLocked(pid, &iid);
  }

  if (worker) {
    worker->stop();
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
    if (it->second.runtime) {
      resolve(@(it->second.runtime->IsSpeechDetected()));
      return;
    }
    resolve(@(false));
  }
}

- (void)unloadVad:(NSString *)instanceId
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  std::string iid = [instanceId UTF8String];
  std::vector<std::shared_ptr<VadPipelineWorker>> workersToStop;
  std::shared_ptr<VadRuntime> runtimeToClose;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    auto instanceIt = g_vad_instances.find(iid);
    if (instanceIt != g_vad_instances.end()) {
      runtimeToClose = instanceIt->second.runtime;
      g_vad_instances.erase(instanceIt);
    }
    auto mapping = g_vad_instance_to_pipeline.find(iid);
    if (mapping != g_vad_instance_to_pipeline.end()) {
      auto worker = DetachPipelineLocked(mapping->second, nullptr);
      if (worker) {
        workersToStop.push_back(worker);
      }
    }
    std::vector<std::string> stalePipelineIds;
    stalePipelineIds.reserve(g_vad_pipelines.size());
    for (const auto &entry : g_vad_pipelines) {
      if (entry.second.instanceId == iid) {
        stalePipelineIds.push_back(entry.first);
      }
    }
    for (const auto &pipelineId : stalePipelineIds) {
      auto worker = DetachPipelineLocked(pipelineId, nullptr);
      if (worker) {
        workersToStop.push_back(worker);
      }
    }
  }
  for (auto &w : workersToStop) {
    if (w) w->stop();
  }
  if (runtimeToClose) {
    runtimeToClose->Reset();
  }
  resolve(nil);
}

@end
