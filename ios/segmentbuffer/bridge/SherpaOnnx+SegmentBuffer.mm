#import "../../SherpaOnnx.h"
#import <Foundation/Foundation.h>
#include "SegmentRegistry.h"
#include "SegJson.h"
#include "SegEngine.h"

#ifdef __cplusplus
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#include <unistd.h>
#include <zlib.h>

namespace {

static NSString *seg_nsstring_from_std(const std::string &value) {
  if (value.empty()) {
    return @"";
  }
  NSString *s = [[NSString alloc] initWithBytes:value.data()
                                          length:value.size()
                                        encoding:NSUTF8StringEncoding];
  if (s) {
    return s;
  }
  s = [[NSString alloc] initWithBytes:value.data()
                               length:value.size()
                             encoding:NSISOLatin1StringEncoding];
  return s ?: @"";
}

static void seg_debug_log(NSString *message) {
#if DEBUG
  NSLog(@"[SherpaOnnx:segment] %@", message);
#else
  (void)message;
#endif
}

static NSDictionary *segRecordToDict(const SegRecord &r) {
#if DEBUG
  seg_debug_log([NSString stringWithFormat:
    @"segRecordToDict idLen=%lu kindLen=%lu srcLen=%lu payloadBytes=%lu",
    (unsigned long)r.id.size(),
    (unsigned long)r.kind.size(),
    (unsigned long)r.sourceAudioBufferId.size(),
    (unsigned long)r.payloadJson.size()]);
#endif
  NSMutableDictionary *dict = [NSMutableDictionary dictionaryWithCapacity:10];
  dict[@"id"] = seg_nsstring_from_std(r.id);
  dict[@"kind"] = seg_nsstring_from_std(r.kind);
  dict[@"sourceAudioBufferId"] = seg_nsstring_from_std(r.sourceAudioBufferId);
  dict[@"startSample"] = @(r.startSample);
  dict[@"endSample"] = @(r.endSample);
  dict[@"sampleRate"] = @(r.sampleRate);
  dict[@"durationMs"] = @(r.durationMs);
  std::string annReason;
  std::string annSource;
  int64_t annCreatedAtMs = 0;
  int annSegmentIndex = 0;
  if (seg_engine_peek_annotation(r.id, &annReason, &annSource, &annCreatedAtMs, &annSegmentIndex)) {
    dict[@"reason"] = seg_nsstring_from_std(annReason);
    dict[@"source"] = seg_nsstring_from_std(annSource);
    dict[@"createdAtMs"] = @(annCreatedAtMs);
  }
  if (r.hasConfidence) dict[@"confidence"] = @(r.confidence);
  if (!r.payloadJson.empty() && r.payloadJson.size() <= NSUIntegerMax) {
    NSData *payloadData = [NSData dataWithBytes:r.payloadJson.data()
                                         length:(NSUInteger)r.payloadJson.size()];
    id payloadObj =
      payloadData ? [NSJSONSerialization JSONObjectWithData:payloadData options:0 error:nil] : nil;
    if ([payloadObj isKindOfClass:[NSDictionary class]]) {
      dict[@"payload"] = (NSDictionary *)payloadObj;
    }
  }
  return dict;
}

static std::string seg_std_from_ns(NSString *value) {
  if (value == nil) return "";
  const char *utf8 = value.UTF8String;
  return utf8 ? std::string(utf8) : std::string();
}

static void seg_lowercase_ascii(std::string *s) {
  if (!s) return;
  for (char &c : *s) {
    const unsigned char uc = static_cast<unsigned char>(c);
    if (uc >= 'A' && uc <= 'Z') c = static_cast<char>(uc - 'A' + 'a');
  }
}

static SegEnginePolicy seg_policy_from_dict(NSDictionary *policy) {
  NSDictionary *p = [policy isKindOfClass:[NSDictionary class]] ? policy : @{};
  SegEnginePolicy out;
  if ([p[@"evaluator"] isKindOfClass:[NSString class]]) {
    out.evaluator = seg_std_from_ns(p[@"evaluator"]);
    seg_lowercase_ascii(&out.evaluator);
  }
  if ([p[@"maxLengthChars"] respondsToSelector:@selector(intValue)]) {
    out.maxLengthChars = [p[@"maxLengthChars"] intValue];
  }
  if ([p[@"sentenceBoundary"] respondsToSelector:@selector(boolValue)]) {
    out.sentenceBoundary = [p[@"sentenceBoundary"] boolValue];
  }
  id rawSbc = p[@"sentenceBoundaryChars"];
  if ([rawSbc isKindOfClass:[NSArray class]]) {
    for (id item in (NSArray *)rawSbc) {
      if (![item isKindOfClass:[NSString class]]) continue;
      NSString *s = (NSString *)item;
      if (s.length == 0) continue;
      out.sentenceBoundaryChars.push_back(seg_std_from_ns(s));
    }
  }
  if ([p[@"silenceThresholdMs"] respondsToSelector:@selector(intValue)]) {
    out.silenceThresholdMs = [p[@"silenceThresholdMs"] intValue];
  }
  if ([p[@"energyThresholdDb"] respondsToSelector:@selector(doubleValue)]) {
    out.energyThresholdDb = [p[@"energyThresholdDb"] doubleValue];
  }
  if ([p[@"minSegmentMs"] respondsToSelector:@selector(intValue)]) {
    out.minSegmentMs = [p[@"minSegmentMs"] intValue];
  }
  if ([p[@"maxSegmentMs"] respondsToSelector:@selector(intValue)]) {
    out.maxSegmentMs = [p[@"maxSegmentMs"] intValue];
  }
  if ([p[@"hangoverMs"] respondsToSelector:@selector(intValue)]) {
    out.hangoverMs = [p[@"hangoverMs"] intValue];
  }
  if ([p[@"checkpointIntervalMs"] respondsToSelector:@selector(intValue)]) {
    out.checkpointIntervalMs = [p[@"checkpointIntervalMs"] intValue];
  }
  if ([p[@"punctuationInstanceId"] isKindOfClass:[NSString class]]) {
    out.punctuationInstanceId = seg_std_from_ns(p[@"punctuationInstanceId"]);
  }
  id rawModelPath = p[@"modelPath"];
  if ([rawModelPath isKindOfClass:[NSString class]]) {
    out.modelPath = seg_std_from_ns(rawModelPath);
  } else if ([rawModelPath isKindOfClass:[NSDictionary class]]) {
    id pathVal = ((NSDictionary *)rawModelPath)[@"path"];
    if ([pathVal isKindOfClass:[NSString class]]) {
      out.modelPath = seg_std_from_ns(pathVal);
    }
  }
  if ([p[@"modelType"] isKindOfClass:[NSString class]]) {
    out.modelType = seg_std_from_ns(p[@"modelType"]);
  }
  if ([p[@"vadThreshold"] respondsToSelector:@selector(doubleValue)]) {
    out.vadThreshold = [p[@"vadThreshold"] doubleValue];
  }
  if ([p[@"vadMinSpeechMs"] respondsToSelector:@selector(intValue)]) {
    out.vadMinSpeechMs = [p[@"vadMinSpeechMs"] intValue];
  }
  if ([p[@"vadMinSilenceMs"] respondsToSelector:@selector(intValue)]) {
    out.vadMinSilenceMs = [p[@"vadMinSilenceMs"] intValue];
  }
  if ([p[@"windowShiftRatio"] respondsToSelector:@selector(doubleValue)]) {
    out.windowShiftRatio = [p[@"windowShiftRatio"] doubleValue];
  }
  if ([p[@"minDurationOn"] respondsToSelector:@selector(doubleValue)]) {
    out.minDurationOn = [p[@"minDurationOn"] doubleValue];
  }
  if ([p[@"minDurationOff"] respondsToSelector:@selector(doubleValue)]) {
    out.minDurationOff = [p[@"minDurationOff"] doubleValue];
  }
  return out;
}

static NSDictionary *seg_engine_policy_to_dict(const SegEnginePolicy &p) {
  NSMutableDictionary *md = [@{
    @"evaluator": seg_nsstring_from_std(p.evaluator),
    @"maxLengthChars": @(p.maxLengthChars),
    @"sentenceBoundary": @(p.sentenceBoundary),
    @"silenceThresholdMs": @(p.silenceThresholdMs),
    @"energyThresholdDb": @(p.energyThresholdDb),
    @"minSegmentMs": @(p.minSegmentMs),
    @"maxSegmentMs": @(p.maxSegmentMs),
    @"hangoverMs": @(p.hangoverMs),
    @"checkpointIntervalMs": @(p.checkpointIntervalMs),
    @"punctuationInstanceId": seg_nsstring_from_std(p.punctuationInstanceId),
    @"vadThreshold": @(p.vadThreshold),
    @"vadMinSpeechMs": @(p.vadMinSpeechMs),
    @"vadMinSilenceMs": @(p.vadMinSilenceMs),
    @"windowShiftRatio": @(p.windowShiftRatio),
    @"minDurationOn": @(p.minDurationOn),
    @"minDurationOff": @(p.minDurationOff),
  } mutableCopy];
  if (!p.sentenceBoundaryChars.empty()) {
    NSMutableArray *arr = [NSMutableArray array];
    for (const auto &s : p.sentenceBoundaryChars) {
      [arr addObject:seg_nsstring_from_std(s)];
    }
    md[@"sentenceBoundaryChars"] = arr;
  }
  if (!p.modelPath.empty()) {
    md[@"modelPath"] = @{
      @"kind": @"fs",
      @"path": seg_nsstring_from_std(p.modelPath),
    };
  }
  if (!p.modelType.empty()) {
    md[@"modelType"] = seg_nsstring_from_std(p.modelType);
  }
  return md;
}

static NSDictionary *seg_engine_info_to_dict(const SegEngineInfoSnapshot &info) {
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  out[@"engineId"] = seg_nsstring_from_std(info.engineId);
  out[@"attachedBufferId"] = seg_nsstring_from_std(info.attachedBufferId);
  out[@"domain"] = seg_nsstring_from_std(info.domain);
  out[@"policy"] = seg_engine_policy_to_dict(info.policy);
  out[@"state"] = [seg_nsstring_from_std(info.state) isEqualToString:@"active"] ? @"active" : @"detached";
  out[@"totalSegmentsCommitted"] = @(info.totalSegmentsCommitted);
  if (!info.lastSegmentId.empty()) out[@"lastSegmentId"] = seg_nsstring_from_std(info.lastSegmentId);
  if (!info.segmentBufferId.empty()) {
    out[@"segmentBufferId"] = seg_nsstring_from_std(info.segmentBufferId);
  }
  return out;
}

static void seg_reject_coded(RCTPromiseRejectBlock reject, const std::string &code,
                             const std::string &error) {
  std::string message = error;
  const std::string prefix = code + ": ";
  if (!code.empty() && message.compare(0, prefix.size(), prefix) == 0) {
    message = message.substr(prefix.size());
  }
  NSString *nsCode = code.empty() ? @"SEGMENT_INTERNAL_ERROR" : seg_nsstring_from_std(code);
  NSString *nsMsg = message.empty() ? @"Segmentation engine error" : seg_nsstring_from_std(message);
  reject(nsCode, nsMsg, nil);
}

static void seg_bind_live_appended_emitter(SherpaOnnx *module,
                                           const std::shared_ptr<SegLiveEntry> &entry) {
  if (!module || !entry) return;
  __weak SherpaOnnx *weakModule = module;
  entry->segmentAppendedEmitter = [weakModule](
    const std::string &segmentBufferId,
    const SegRecord &rec,
    int segIdx,
    int totalSegments
  ) {
    SherpaOnnx *m = weakModule;
    if (!m) return;
    NSMutableDictionary *body = [NSMutableDictionary dictionary];
    body[@"segmentBufferId"] = seg_nsstring_from_std(segmentBufferId);
    body[@"segmentId"] = seg_nsstring_from_std(rec.id);
    body[@"kind"] = rec.kind.empty() ? @"speech" : seg_nsstring_from_std(rec.kind);
    body[@"segmentIndex"] = @(segIdx);
    body[@"totalSegments"] = @(totalSegments);
    body[@"sourceAudioBufferId"] = seg_nsstring_from_std(rec.sourceAudioBufferId);
    body[@"startSample"] = @(rec.startSample);
    body[@"endSample"] = @(rec.endSample);
    body[@"sampleRate"] = @(rec.sampleRate);
    body[@"durationMs"] = @(rec.durationMs);
    std::string annReason;
    std::string annSource;
    int64_t annCreatedAtMs = 0;
    int annSegmentIndex = 0;
    if (seg_engine_peek_annotation(rec.id, &annReason, &annSource, &annCreatedAtMs, &annSegmentIndex)) {
      body[@"reason"] = seg_nsstring_from_std(annReason);
      body[@"source"] = seg_nsstring_from_std(annSource);
      body[@"createdAtMs"] = @(annCreatedAtMs);
    } else {
      body[@"reason"] = @"manual_commit";
      body[@"source"] = @"manual";
      body[@"createdAtMs"] = @((int64_t)([[NSDate date] timeIntervalSince1970] * 1000.0));
    }
    if (rec.hasConfidence) body[@"confidence"] = @(rec.confidence);
    dispatch_async(dispatch_get_main_queue(), ^{
      [m sendEventWithName:@"pipelineLiveSegmentAppended" body:body];
    });
  };
}

}  // namespace

#endif

@implementation SherpaOnnx (SegmentBuffer)

- (void)attachSegmentationEngine:(NSString *)bufferId
                          domain:(NSString *)domain
                          policy:(NSDictionary *)policy
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  try {
    const std::string bid = seg_std_from_ns(bufferId);
    std::string domainRaw = seg_std_from_ns(domain);
    seg_lowercase_ascii(&domainRaw);
    SegEnginePolicy parsed = seg_policy_from_dict(policy);
    SegEngineInfoSnapshot info;
    std::string code;
    std::string error;
    if (!seg_engine_attach(bid, domainRaw, parsed, &info, &code, &error)) {
      seg_reject_coded(reject, code, error);
      return;
    }
    if (!info.segmentBufferId.empty()) {
      auto entry = seg_get_live_entry(info.segmentBufferId);
      if (entry) seg_bind_live_appended_emitter(self, entry);
    }
    resolve(seg_engine_info_to_dict(info));
  } catch (const std::exception &e) {
    reject(@"SEGMENT_INTERNAL_ERROR", seg_nsstring_from_std(e.what()), nil);
  }
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"Segmentation engine unavailable", nil);
#endif
}

- (void)detachSegmentationEngine:(NSString *)engineId
                       flushFinal:(NSNumber *)flushFinal
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::string error;
  if (!seg_engine_detach(seg_std_from_ns(engineId), flushFinal.boolValue, &error)) {
    std::string code = "ENGINE_DETACHED";
    const auto colon = error.find(':');
    if (colon != std::string::npos && colon > 0) code = error.substr(0, colon);
    seg_reject_coded(reject, code, error);
    return;
  }
  resolve(nil);
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"Segmentation engine unavailable", nil);
#endif
}

- (void)getSegmentationEngineInfo:(NSString *)engineId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  SegEngineInfoSnapshot info;
  std::string code;
  std::string error;
  if (!seg_engine_get_info(seg_std_from_ns(engineId), &info, &code, &error)) {
    seg_reject_coded(reject, code.empty() ? std::string("ENGINE_DETACHED") : code, error);
    return;
  }
  resolve(seg_engine_info_to_dict(info));
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"Segmentation engine unavailable", nil);
#endif
}

- (void)segmentOfflineBuffer:(NSString *)bufferId
                       domain:(NSString *)domain
                       policy:(NSDictionary *)policy
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    const std::string bid = seg_std_from_ns(bufferId);
    std::string domainRaw = seg_std_from_ns(domain);
    seg_lowercase_ascii(&domainRaw);
    SegEnginePolicy parsed = seg_policy_from_dict(policy);
    std::vector<SegOfflineTextSegment> segments;
    std::string outId;
    int count = 0;
    std::string code;
    std::string error;
    if (!seg_engine_segment_offline(bid, domainRaw, parsed, &segments, &outId, &count, &code,
                                    &error)) {
      seg_reject_coded(reject, code, error);
      return;
    }
    if (domainRaw == "text") {
      NSMutableArray *arr = [NSMutableArray arrayWithCapacity:segments.size()];
      for (const auto &segment : segments) {
        [arr addObject:@{
          @"segmentId": seg_nsstring_from_std(segment.segmentId),
          @"startOffset": @(segment.startOffset),
          @"endOffset": @(segment.endOffset),
          @"reason": seg_nsstring_from_std(segment.reason),
          @"source": seg_nsstring_from_std(segment.source),
          @"text": seg_nsstring_from_std(segment.text),
        }];
      }
      resolve(@{
        @"bufferId": bufferId ?: @"",
        @"kind": @"offlineTextBuffer",
        @"state": @"immutable",
        @"segmentCount": @(count),
        @"segments": arr,
      });
      return;
    }
    resolve(@{
      @"bufferId": seg_nsstring_from_std(outId),
      @"kind": @"offlineSegmentBuffer",
      @"state": @"immutable",
      @"segmentCount": @(count),
      @"sourceAudioBufferId": bufferId ?: @"",
    });
  } @catch (NSException *exception) {
    reject(@"SEGMENT_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"Segmentation engine unavailable", nil);
#endif
}

- (void)createLiveSegmentBuffer:(JS::NativeSherpaOnnx::SpecCreateLiveSegmentBufferOptions &)options
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  try {
    auto entry = std::make_shared<SegLiveEntry>();
    entry->bufferId = seg_generate_id("seg_live");
    NSString *sourceAudioBufferId = options.sourceAudioBufferId();
    entry->sourceAudioBufferId = sourceAudioBufferId != nil ? [sourceAudioBufferId UTF8String] : "";
    auto maxSegmentsOpt = options.maxSegments();
    entry->maxSegments = maxSegmentsOpt.has_value() ? std::max(1, static_cast<int>(maxSegmentsOpt.value())) : 4096;
    NSString *modeRaw = options.spoolingMode();
    if (modeRaw == nil || modeRaw.length == 0) modeRaw = @"on";
    if ([modeRaw isEqualToString:@"off"]) entry->spoolingMode = SegLiveEntry::SPOOL_OFF;
    else if ([modeRaw isEqualToString:@"auto"]) entry->spoolingMode = SegLiveEntry::SPOOL_AUTO;
    else entry->spoolingMode = SegLiveEntry::SPOOL_ON;

    NSString *spoolPath = options.spoolingPath();
    if (entry->spoolingMode != SegLiveEntry::SPOOL_OFF) {
      if (spoolPath.length > 0) {
        entry->spoolPath = spoolPath.UTF8String;
      } else {
        NSString *tmp = [NSTemporaryDirectory() stringByAppendingPathComponent:
                         [NSString stringWithFormat:@"seg_spool_%@.json", [NSUUID UUID].UUIDString]];
        entry->spoolPath = tmp.UTF8String;
      }
    }
    if (auto spoolingTemporaryOpt = options.spoolingTemporary()) {
      entry->spoolTemporary = spoolingTemporaryOpt.value();
    } else {
      entry->spoolTemporary = (spoolPath.length == 0);
    }
    if (auto spoolingThresholdBytesOpt = options.spoolingThresholdBytes()) {
      entry->spoolThresholdBytes = static_cast<int64_t>(spoolingThresholdBytesOpt.value());
    }
    auto emitSegmentAppendedOpt = options.emitSegmentAppendedEvents();
    entry->emitSegmentAppended = emitSegmentAppendedOpt.has_value() && emitSegmentAppendedOpt.value();
    if (auto segmentEventMinIntervalMsOpt = options.segmentEventMinIntervalMs()) {
      entry->segmentEventMinIntervalMs = static_cast<int64_t>(segmentEventMinIntervalMsOpt.value());
    }
    seg_bind_live_appended_emitter(self, entry);
    if (entry->spoolingMode == SegLiveEntry::SPOOL_ON) {
      entry->activateSpoolIfNeeded();
    }
    {
      std::lock_guard<std::mutex> lock(g_seg_mutex);
      g_seg_live[entry->bufferId] = entry;
    }
    NSMutableDictionary *out = [@{
      @"bufferId": [NSString stringWithUTF8String:entry->bufferId.c_str()],
      @"kind": @"liveSegmentBuffer",
      @"state": @"recording",
      @"segmentCount": @(0),
      @"totalSegmentsWritten": @(0),
      @"spoolMode": [NSString stringWithUTF8String:SegLiveEntry::modeRaw(entry->spoolingMode).c_str()],
      @"spoolEnabled": @(entry->spoolEnabled()),
      @"spoolReady": @(entry->spoolReady),
      @"spoolBytes": @(entry->spoolBytes),
    } mutableCopy];
    if (!entry->sourceAudioBufferId.empty()) out[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:entry->sourceAudioBufferId.c_str()];
    if (!entry->spoolPath.empty()) out[@"spoolPath"] = [NSString stringWithUTF8String:entry->spoolPath.c_str()];
    resolve(out);
  } catch (const std::exception &e) {
    NSString *msg = [NSString stringWithUTF8String:e.what()];
    NSString *code = @"SEGMENT_INTERNAL_ERROR";
    NSRange idx = [msg rangeOfString:@":"];
    if (idx.location != NSNotFound) {
      code = [msg substringToIndex:idx.location];
      msg = [[msg substringFromIndex:idx.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    }
    reject(code, msg, nil);
  }
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)createEmptyOfflineSegmentBuffer:(JS::NativeSherpaOnnx::SpecCreateEmptyOfflineSegmentBufferOptions &)options
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  auto entry = std::make_shared<SegOfflineEntry>();
  entry->bufferId = seg_generate_id("seg_off");
  if (NSString *sourceAudioBufferId = options.sourceAudioBufferId()) {
    entry->sourceAudioBufferId = [sourceAudioBufferId UTF8String];
  }
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    g_seg_offline[entry->bufferId] = entry;
  }
  NSMutableDictionary *out = [@{
    @"bufferId": [NSString stringWithUTF8String:entry->bufferId.c_str()],
    @"kind": @"offlineSegmentBuffer",
    @"state": @"immutable",
    @"segmentCount": @((int)entry->segments.size()),
  } mutableCopy];
  if (!entry->sourceAudioBufferId.empty()) {
    out[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:entry->sourceAudioBufferId.c_str()];
  }
  resolve(out);
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)appendLiveSegment:(NSString *)liveBufferId
                     kind:(NSString *)kind
      sourceAudioBufferId:(NSString *)sourceAudioBufferId
              startSample:(double)startSample
                endSample:(double)endSample
               sampleRate:(double)sampleRate
               durationMs:(NSNumber *)durationMs
               confidence:(NSNumber *)confidence
                  payload:(NSDictionary *)payload
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::string payloadJson;
  if ([payload isKindOfClass:[NSDictionary class]]) {
    NSData *pd = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    if (pd) payloadJson.assign((const char *)pd.bytes, (size_t)pd.length);
  }
  const std::string kindStr = kind.length > 0 ? kind.UTF8String : "speech";
  const int duration =
      durationMs != nil
          ? durationMs.intValue
          : (int)((((int)endSample - (int)startSample) * 1000.0) / std::max(1, (int)sampleRate));
  std::string segmentId;
  int segmentIndex = -1;
  std::string err;
  if (!seg_live_append_segment(
          liveBufferId.UTF8String, kindStr,
          sourceAudioBufferId.length > 0 ? sourceAudioBufferId.UTF8String : "", (int)startSample,
          (int)endSample, (int)sampleRate, duration, confidence != nil,
          confidence != nil ? confidence.doubleValue : 0.0, payloadJson, &segmentId, &segmentIndex,
          &err)) {
    NSString *msg = err.empty() ? @"appendLiveSegment failed" : [NSString stringWithUTF8String:err.c_str()];
    NSString *code = @"SEGMENT_INTERNAL_ERROR";
    NSRange idx = [msg rangeOfString:@":"];
    if (idx.location != NSNotFound) {
      code = [msg substringToIndex:idx.location];
      msg = [[msg substringFromIndex:idx.location + 1]
          stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    }
    reject(code, msg, nil);
    return;
  }

  if ([payload isKindOfClass:[NSDictionary class]]) {
    NSString *annReason =
        [payload[@"__annotationReason"] isKindOfClass:[NSString class]] ? payload[@"__annotationReason"]
                                                                        : nil;
    NSString *annSource =
        [payload[@"__annotationSource"] isKindOfClass:[NSString class]] ? payload[@"__annotationSource"]
                                                                        : nil;
    if (annReason.length > 0 && annSource.length > 0) {
      int64_t annCreatedAtMs =
          [payload[@"__annotationCreatedAtMs"] isKindOfClass:[NSNumber class]]
              ? ((NSNumber *)payload[@"__annotationCreatedAtMs"]).longLongValue
              : (int64_t)([[NSDate date] timeIntervalSince1970] * 1000.0);
      seg_engine_record_annotation(segmentId, annReason.UTF8String ?: "", annSource.UTF8String ?: "",
                                   annCreatedAtMs, segmentIndex);
    }
  }

  resolve(@{
    @"segmentId": [NSString stringWithUTF8String:segmentId.c_str()],
    @"segmentIndex": @(segmentIndex),
  });
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)finalizeLiveSegmentBuffer:(NSString *)liveBufferId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::shared_ptr<SegLiveEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto it = g_seg_live.find(liveBufferId.UTF8String);
    if (it == g_seg_live.end()) {
      reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Live segment buffer not found: %@", liveBufferId], nil);
      return;
    }
    entry = it->second;
  }
  try {
    entry->finalize_();
    resolve(nil);
  } catch (const std::exception &e) {
    NSString *msg = [NSString stringWithUTF8String:e.what()];
    NSString *code = @"SEGMENT_INTERNAL_ERROR";
    NSRange idx = [msg rangeOfString:@":"];
    if (idx.location != NSNotFound) {
      code = [msg substringToIndex:idx.location];
      msg = [[msg substringFromIndex:idx.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    }
    reject(code, msg, nil);
  }
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)createOfflineSegmentBufferFromLive:(NSString *)liveBufferId
                                      mode:(NSString *)mode
                                   resolve:(RCTPromiseResolveBlock)resolve
                                    reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::string offlineId;
  std::string err;
  const std::string modeStr = mode != nil ? mode.UTF8String : "fullIfSpooled";
  if (!seg_create_offline_from_live(liveBufferId.UTF8String, modeStr, &offlineId, &err)) {
    NSString *msg = err.empty() ? @"createOfflineFromLive failed" : [NSString stringWithUTF8String:err.c_str()];
    NSString *code = @"SEGMENT_INTERNAL_ERROR";
    NSRange idx = [msg rangeOfString:@":"];
    if (idx.location != NSNotFound) {
      code = [msg substringToIndex:idx.location];
      msg = [[msg substringFromIndex:idx.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    }
    reject(code, msg, nil);
    return;
  }
  auto off = seg_get_offline_entry(offlineId);
  if (!off) {
    reject(@"SEGMENT_INTERNAL_ERROR", @"Offline segment buffer missing after create", nil);
    return;
  }
  NSMutableDictionary *out = [@{
    @"bufferId": [NSString stringWithUTF8String:off->bufferId.c_str()],
    @"kind": @"offlineSegmentBuffer",
    @"state": @"immutable",
    @"segmentCount": @(seg_offline_segment_count(offlineId)),
  } mutableCopy];
  if (!off->sourceAudioBufferId.empty()) {
    out[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:off->sourceAudioBufferId.c_str()];
  }
  resolve(out);
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)populateOfflineSegmentBufferIfEmpty:(NSString *)targetBufferId
                                liveBufferId:(NSString *)liveBufferId
                                        mode:(NSString *)mode
                                     resolve:(RCTPromiseResolveBlock)resolve
                                      reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::string err;
  const std::string modeStr = mode != nil ? mode.UTF8String : "fullIfSpooled";
  if (!seg_populate_offline_from_live_if_empty(targetBufferId.UTF8String, liveBufferId.UTF8String,
                                               modeStr, &err)) {
    NSString *msg = err.empty() ? @"populateOfflineFromLiveIfEmpty failed" : [NSString stringWithUTF8String:err.c_str()];
    NSString *code = @"SEGMENT_INTERNAL_ERROR";
    NSRange idx = [msg rangeOfString:@":"];
    if (idx.location != NSNotFound) {
      code = [msg substringToIndex:idx.location];
      msg = [[msg substringFromIndex:idx.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    }
    reject(code, msg, nil);
    return;
  }
  resolve(nil);
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)getPipelineSegmentBufferInfo:(NSString *)bufferId
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::lock_guard<std::mutex> lock(g_seg_mutex);
  auto offIt = g_seg_offline.find(bufferId.UTF8String);
  if (offIt != g_seg_offline.end()) {
    auto &off = offIt->second;
    NSMutableDictionary *out = [@{
      @"bufferId": [NSString stringWithUTF8String:off->bufferId.c_str()],
      @"kind": @"offlineSegmentBuffer",
      @"state": @"immutable",
      @"segmentCount": @((int)off->segments.size()),
    } mutableCopy];
    if (!off->sourceAudioBufferId.empty()) out[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:off->sourceAudioBufferId.c_str()];
    resolve(out);
    return;
  }
  auto liveIt = g_seg_live.find(bufferId.UTF8String);
  if (liveIt != g_seg_live.end()) {
    auto &live = liveIt->second;
    NSMutableDictionary *out = [@{
      @"bufferId": [NSString stringWithUTF8String:live->bufferId.c_str()],
      @"kind": @"liveSegmentBuffer",
      @"state": live->state == SegLiveEntry::RECORDING ? @"recording" : @"finished",
      @"segmentCount": @((int)live->segments.size()),
      @"totalSegmentsWritten": @(live->totalSegmentsWritten),
      @"spoolMode": [NSString stringWithUTF8String:SegLiveEntry::modeRaw(live->spoolingMode).c_str()],
      @"spoolEnabled": @(live->spoolEnabled()),
      @"spoolReady": @(live->spoolReady),
      @"spoolBytes": @(live->spoolBytes),
    } mutableCopy];
    if (!live->sourceAudioBufferId.empty()) out[@"sourceAudioBufferId"] = [NSString stringWithUTF8String:live->sourceAudioBufferId.c_str()];
    if (!live->spoolPath.empty()) out[@"spoolPath"] = [NSString stringWithUTF8String:live->spoolPath.c_str()];
    resolve(out);
    return;
  }
  reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Segment buffer not found: %@", bufferId], nil);
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)getOfflineSegmentBufferSegments:(NSString *)bufferId
                                  start:(NSNumber *)start
                               maxCount:(NSNumber *)maxCount
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  // Codegen passes optional slice args as NSNumber* (see SherpaOnnxSpec.h). Using
  // double here misaligns NSInvocation and corrupts resolve/reject (SIGSEGV).
  const double startVal = start != nil ? start.doubleValue : 0.0;
  const double maxCountVal = maxCount != nil ? maxCount.doubleValue : 4096.0;
#if DEBUG
  seg_debug_log([NSString stringWithFormat:
    @"getOfflineSegmentBufferSegments enter bufferId=%@ start=%.3f maxCount=%.3f thread=%@",
    bufferId ?: @"<nil>",
    startVal,
    maxCountVal,
    [NSThread isMainThread] ? @"main" : @"background"]);
#endif
  @try {
    if (!std::isfinite(startVal) || !std::isfinite(maxCountVal)) {
      seg_debug_log(@"getOfflineSegmentBufferSegments reject invalid finite slice");
      reject(@"SEGMENT_SLICE_INVALID", @"Invalid slice range", nil);
      return;
    }
    const int64_t s64 = static_cast<int64_t>(startVal);
    const int64_t c64 = static_cast<int64_t>(maxCountVal);
    if (s64 < 0 || c64 < 0) {
      seg_debug_log(@"getOfflineSegmentBufferSegments reject negative slice");
      reject(@"SEGMENT_SLICE_INVALID", @"Invalid slice range", nil);
      return;
    }

    const char *bufferKey = bufferId.UTF8String;
    if (bufferKey == nullptr || !seg_get_offline_entry(bufferKey)) {
      seg_debug_log([NSString stringWithFormat:
        @"getOfflineSegmentBufferSegments reject not found bufferId=%@",
        bufferId ?: @"<nil>"]);
      reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Offline segment buffer not found: %@", bufferId], nil);
      return;
    }
    const int total = seg_offline_segment_count(bufferKey);
    const int pageCount =
        seg_clamp_tm_page_count(c64 > SEG_TM_MAX_PAGE_COUNT ? SEG_TM_MAX_PAGE_COUNT : static_cast<int>(c64));
    std::vector<SegRecord> snap =
        seg_offline_get_segments(bufferKey, static_cast<int>(s64), pageCount);
#if DEBUG
    seg_debug_log([NSString stringWithFormat:
      @"getOfflineSegmentBufferSegments slice total=%d s=%lld c=%lld snap=%lu",
      total,
      (long long)s64,
      (long long)c64,
      (unsigned long)snap.size()]);
#endif

    NSArray *segmentsOut = nil;
    if (snap.empty()) {
      segmentsOut = @[];
    } else {
      NSMutableArray *arr = [NSMutableArray arrayWithCapacity:snap.size()];
      seg_debug_log([NSString stringWithFormat:
        @"getOfflineSegmentBufferSegments serializing snapCount=%lu",
        (unsigned long)snap.size()]);
      for (const auto &r : snap) {
        [arr addObject:segRecordToDict(r)];
      }
      segmentsOut = [arr copy];
    }
    seg_debug_log([NSString stringWithFormat:
      @"getOfflineSegmentBufferSegments resolve segments=%lu",
      (unsigned long)segmentsOut.count]);
    resolve(@{@"segments": segmentsOut});
  } @catch (NSException *exception) {
    seg_debug_log([NSString stringWithFormat:
      @"getOfflineSegmentBufferSegments exception name=%@ reason=%@",
      exception.name ?: @"<nil>",
      exception.reason ?: @"<nil>"]);
    reject(@"SEGMENT_INTERNAL_ERROR", exception.reason ?: @"Failed to read offline segments", nil);
  }
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)getLiveSegmentBufferSegments:(NSString *)liveBufferId
                          startIndex:(double)startIndex
                            maxCount:(double)maxCount
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
#if DEBUG
  seg_debug_log([NSString stringWithFormat:
    @"getLiveSegmentBufferSegments enter bufferId=%@ start=%.3f maxCount=%.3f thread=%@",
    liveBufferId ?: @"<nil>",
    startIndex,
    maxCount,
    [NSThread isMainThread] ? @"main" : @"background"]);
#endif
  @try {
    if (!std::isfinite(startIndex) || !std::isfinite(maxCount)) {
      seg_debug_log(@"getLiveSegmentBufferSegments reject invalid finite slice");
      reject(@"SEGMENT_SLICE_INVALID", @"Invalid slice range", nil);
      return;
    }
    const int64_t s64 = static_cast<int64_t>(startIndex);
    const int64_t c64 = static_cast<int64_t>(maxCount);
    if (s64 < 0 || c64 < 0) {
      seg_debug_log(@"getLiveSegmentBufferSegments reject negative slice");
      reject(@"SEGMENT_SLICE_INVALID", @"Invalid slice range", nil);
      return;
    }
    const char *bufferKey = liveBufferId.UTF8String;
    if (bufferKey == nullptr || !seg_get_live_entry(bufferKey)) {
      reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Live segment buffer not found: %@", liveBufferId], nil);
      return;
    }
    const int pageCount =
        seg_clamp_tm_page_count(c64 > SEG_TM_MAX_PAGE_COUNT ? SEG_TM_MAX_PAGE_COUNT : static_cast<int>(c64));
    std::vector<SegRecord> snap =
        seg_live_get_window_segments(bufferKey, static_cast<int>(s64), pageCount);
    NSArray *segmentsOut = nil;
    if (snap.empty()) {
      segmentsOut = @[];
    } else {
      NSMutableArray *arr = [NSMutableArray arrayWithCapacity:snap.size()];
      seg_debug_log([NSString stringWithFormat:
        @"getLiveSegmentBufferSegments serializing snapCount=%lu",
        (unsigned long)snap.size()]);
      for (const auto &r : snap) {
        [arr addObject:segRecordToDict(r)];
      }
      segmentsOut = [arr copy];
    }
    seg_debug_log([NSString stringWithFormat:
      @"getLiveSegmentBufferSegments resolve segments=%lu",
      (unsigned long)segmentsOut.count]);
    resolve(@{@"segments": segmentsOut});
  } @catch (NSException *exception) {
    seg_debug_log([NSString stringWithFormat:
      @"getLiveSegmentBufferSegments exception name=%@ reason=%@",
      exception.name ?: @"<nil>",
      exception.reason ?: @"<nil>"]);
    reject(@"SEGMENT_INTERNAL_ERROR", exception.reason ?: @"Failed to read live segments", nil);
  }
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)getLiveSegmentBufferSegmentCount:(NSString *)liveBufferId
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::lock_guard<std::mutex> lock(g_seg_mutex);
  auto it = g_seg_live.find(liveBufferId.UTF8String);
  if (it == g_seg_live.end()) {
    reject(@"SEGMENT_BUFFER_NOT_FOUND", [NSString stringWithFormat:@"Live segment buffer not found: %@", liveBufferId], nil);
    return;
  }
  resolve(@((int)it->second->segments.size()));
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

- (void)releasePipelineSegmentBuffer:(NSString *)bufferId
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  std::shared_ptr<SegLiveEntry> live;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto lit = g_seg_live.find(bufferId.UTF8String);
    if (lit != g_seg_live.end()) {
      live = lit->second;
      g_seg_live.erase(lit);
    }
    g_seg_offline.erase(bufferId.UTF8String);
  }
  if (live) {
    try { live->release(); } catch (...) {}
  }
  resolve(nil);
#else
  reject(@"SEGMENT_INTERNAL_ERROR", @"SegmentBuffer unavailable", nil);
#endif
}

@end
