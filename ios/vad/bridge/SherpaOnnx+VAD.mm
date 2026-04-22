#import "../../SherpaOnnx.h"

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"

#include <cmath>
#include <mutex>
#include <string>
#include <unordered_map>

namespace {
struct VadInstanceState {
  int sampleRate = 16000;
  double threshold = 0.015;
  int minSpeechDurationMs = 120;
  bool speechDetected = false;
};

struct VadPipelineState {
  std::string instanceId;
  bool running = true;
  bool flushing = false;
  int queueDepth = 0;
  int64_t chunksProcessed = 0;
  int64_t unitsRead = 0;
  int64_t unitsWritten = 0;
  std::string error;
};

std::mutex g_vad_mutex;
std::unordered_map<std::string, VadInstanceState> g_vad_instances;
std::unordered_map<std::string, VadPipelineState> g_vad_pipelines;
int64_t g_vad_pipeline_counter = 0;
} // namespace

@implementation SherpaOnnx (VAD)

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
  (void)options;
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
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    if (g_vad_instances.find(iid) == g_vad_instances.end()) {
      reject(@"VAD_MODEL_INIT_FAILED", @"VAD instance not initialized", nil);
      return;
    }
    for (const auto &it : g_vad_pipelines) {
      if (it.second.instanceId == iid && it.second.running) {
        reject(@"VAD_PIPELINE_ALREADY_RUNNING", @"VAD pipeline already running for instance", nil);
        return;
      }
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

  std::string pid;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    pid = "vad_pipeline_" + std::to_string(++g_vad_pipeline_counter);
    VadPipelineState p;
    p.instanceId = iid;
    p.running = true;
    g_vad_pipelines[pid] = p;
  }

  [self sendEventWithName:@"vadEvent"
                     body:@{
                       @"type": @"pipeline.started",
                       @"instanceId": instanceId,
                       @"pipelineId": [NSString stringWithUTF8String:pid.c_str()],
                       @"ts": @((double)([[NSDate date] timeIntervalSince1970] * 1000.0))
                     }];
  resolve(@{ @"pipelineId": [NSString stringWithUTF8String:pid.c_str()] });
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
  reject(@"VAD_BUFFER_KIND_MISMATCH", @"runVadOffline currently requires an offline segment buffer output on iOS", nil);
}

- (void)flushVad:(NSString *)pipelineId
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  std::lock_guard<std::mutex> lock(g_vad_mutex);
  auto it = g_vad_pipelines.find([pipelineId UTF8String]);
  if (it == g_vad_pipelines.end()) {
    reject(@"VAD_PIPELINE_NOT_FOUND", @"VAD pipeline not found", nil);
    return;
  }
  it->second.flushing = false;
  resolve(nil);
}

- (void)resetVad:(NSString *)pipelineId
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  std::lock_guard<std::mutex> lock(g_vad_mutex);
  auto it = g_vad_pipelines.find([pipelineId UTF8String]);
  if (it == g_vad_pipelines.end()) {
    reject(@"VAD_PIPELINE_NOT_FOUND", @"VAD pipeline not found", nil);
    return;
  }
  it->second.chunksProcessed = 0;
  it->second.unitsRead = 0;
  it->second.unitsWritten = 0;
  it->second.error.clear();
  resolve(nil);
}

- (void)stopVadPipeline:(NSString *)pipelineId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  std::string pid = [pipelineId UTF8String];
  std::string iid;
  {
    std::lock_guard<std::mutex> lock(g_vad_mutex);
    auto it = g_vad_pipelines.find(pid);
    if (it == g_vad_pipelines.end()) {
      reject(@"VAD_PIPELINE_NOT_FOUND", @"VAD pipeline not found", nil);
      return;
    }
    iid = it->second.instanceId;
    it->second.running = false;
    g_vad_pipelines.erase(it);
  }
  [self sendEventWithName:@"vadEvent"
                     body:@{
                       @"type": @"pipeline.completed",
                       @"instanceId": [NSString stringWithUTF8String:iid.c_str()],
                       @"pipelineId": pipelineId,
                       @"ts": @((double)([[NSDate date] timeIntervalSince1970] * 1000.0)),
                       @"chunksProcessed": @(0),
                       @"unitsRead": @(0),
                       @"unitsWritten": @(0),
                       @"segmentCount": @(0),
                       @"speechDurationMs": @(0)
                     }];
  resolve(nil);
}

- (void)getVadPipelineStatus:(NSString *)pipelineId
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  std::lock_guard<std::mutex> lock(g_vad_mutex);
  auto it = g_vad_pipelines.find([pipelineId UTF8String]);
  if (it == g_vad_pipelines.end()) {
    reject(@"VAD_PIPELINE_NOT_FOUND", @"VAD pipeline not found", nil);
    return;
  }
  resolve(@{
    @"pipelineId": pipelineId,
    @"isRunning": @(it->second.running),
    @"isFlushing": @(it->second.flushing),
    @"queueDepth": @(it->second.queueDepth),
    @"chunksProcessed": @((double)it->second.chunksProcessed),
    @"unitsRead": @((double)it->second.unitsRead),
    @"unitsWritten": @((double)it->second.unitsWritten),
    @"error": it->second.error.empty() ? [NSNull null] : [NSString stringWithUTF8String:it->second.error.c_str()]
  });
}

- (void)isVadSpeechDetected:(NSString *)instanceId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  std::lock_guard<std::mutex> lock(g_vad_mutex);
  auto it = g_vad_instances.find([instanceId UTF8String]);
  if (it == g_vad_instances.end()) {
    reject(@"VAD_MODEL_INIT_FAILED", @"VAD instance not initialized", nil);
    return;
  }
  resolve(@(it->second.speechDetected));
}

- (void)unloadVad:(NSString *)instanceId
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  (void)reject;
  std::string iid = [instanceId UTF8String];
  std::lock_guard<std::mutex> lock(g_vad_mutex);
  g_vad_instances.erase(iid);
  for (auto it = g_vad_pipelines.begin(); it != g_vad_pipelines.end();) {
    if (it->second.instanceId == iid) {
      it = g_vad_pipelines.erase(it);
    } else {
      ++it;
    }
  }
  resolve(nil);
}

@end
