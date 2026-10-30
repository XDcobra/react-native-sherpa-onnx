#import "SherpaOnnx.h"

#include "VideoImageBridge.h"
#include "VideoLog.h"
#include "VideoRegistry.h"
#include "audio/LiveAudioTap.h"
#include "audio/VideoAudioExtractor.h"
#include "core/Uuid.h"
#include "../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "decode/DecoderBackend.h"
#include "decode/DecoderPool.h"
#include "live/LiveIngest.h"
#include "live/LiveVideoEntry.h"

#import "VideoToolboxDecoder.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <unistd.h>
#include <unordered_map>
#include <vector>

using sherpa_onnx::video::ImageBridgeRequest;
using sherpa_onnx::video::LiveIngest;
using sherpa_onnx::video::LiveIngestOptions;
using sherpa_onnx::video::LiveVideoOptions;
using sherpa_onnx::video::RegisterDecoderFactory;
using sherpa_onnx::video::SamplingMode;
using sherpa_onnx::video::SetVideoLogEnabled;
using sherpa_onnx::video::SpoolRetentionMode;
using sherpa_onnx::video::VideoBufferInfo;
using sherpa_onnx::video::VideoBufferState;
using sherpa_onnx::video::VideoKind;
using sherpa_onnx::video::VideoRegistry;
using sherpa_onnx::video::VideoToolboxDecoder;

extern "C" void SherpaVideoInstallMemoryPressureObserver(void);

namespace {

SherpaOnnx *gVideoModule = nil;
std::mutex gLiveAudioTapMu;
std::unordered_map<std::string, std::unique_ptr<sherpa_onnx::video::LiveAudioTap>>
    gLiveAudioTaps;

void EnsureVideoInit() {
  static std::once_flag once;
  std::call_once(once, []() {
    NSString *cache =
        [NSTemporaryDirectory() stringByAppendingPathComponent:@"sherpa-video"];
    [[NSFileManager defaultManager] createDirectoryAtPath:cache
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    auto &reg = VideoRegistry::Instance();
    reg.SetCacheDir([cache UTF8String]);
    uint64_t ram = [[NSProcessInfo processInfo] physicalMemory];
    reg.ConfigureRam(ram);
#if DEBUG
    SetVideoLogEnabled(true);
#endif
    RegisterDecoderFactory([]() {
      return std::unique_ptr<sherpa_onnx::video::DecoderBackend>(
          new VideoToolboxDecoder());
    });
    SherpaVideoInstallMemoryPressureObserver();
    (void)reg.SweepOrphans();
    reg.SetEventSink([](const std::string &type, const std::string &bufferId,
                        const std::string &json) {
      SherpaOnnx *mod = gVideoModule;
      if (mod == nil) return;
      NSString *t = [NSString stringWithUTF8String:type.c_str()];
      NSString *bid = [NSString stringWithUTF8String:bufferId.c_str()];
      [mod sendEventWithName:@"SherpaOnnxVideoEvent"
                        body:@{
                          @"type" : t ?: @"",
                          @"liveBufferId" : bid ?: @"",
                          @"payload" : [NSString stringWithUTF8String:json.c_str()]
                              ?: @"",
                        }];
    });
  });
}

void BindVideoModule(SherpaOnnx *mod) {
  gVideoModule = mod;
  EnsureVideoInit();
}

NSDictionary *VideoInfoDict(const VideoBufferInfo &info) {
  NSString *kind = info.kind == VideoKind::Live ? @"liveVideoBuffer"
                                                : @"offlineVideoBuffer";
  NSString *state = @"immutable";
  if (info.state == VideoBufferState::Recording) {
    state = @"recording";
  } else if (info.state == VideoBufferState::Finished) {
    state = @"finished";
  }
  NSMutableDictionary *dict = [@{
    @"bufferId" : [NSString stringWithUTF8String:info.bufferId.c_str()],
    @"kind" : kind,
    @"state" : state,
    @"frameCount" : @(info.frameCount),
    @"liveEdgeUs" : @(info.liveEdgeUs),
    @"totalFramesWritten" : @(info.totalFramesWritten),
    @"ringEvictedFrames" : @(info.ringEvictedFrames),
    @"hasActiveSpool" : info.hasActiveSpool ? @"true" : @"false",
    @"seekableStartUs" : @(info.seekableRange.startUs),
    @"seekableEndUs" : @(info.seekableRange.endUs),
  } mutableCopy];
  if (info.audio) {
    const char *codec = info.audio->codecName.empty()
                            ? sherpa_onnx::video::AudioCodecName(info.audio->codec)
                            : info.audio->codecName.c_str();
    dict[@"audioCodec"] = [NSString stringWithUTF8String:codec];
    dict[@"audioDecodable"] = info.audio->decodable ? @"true" : @"false";
    dict[@"audioSampleRate"] = @(info.audio->sampleRate);
    dict[@"audioChannels"] = @(info.audio->channels);
    dict[@"audioStartUs"] = @(info.audioRange.startUs);
    dict[@"audioDurationUs"] =
        @(info.audioRange.endUs > info.audioRange.startUs
              ? info.audioRange.endUs - info.audioRange.startUs
              : 0);
  }
  return dict;
}

NSDictionary *VideoError(const char *code, const std::string &msg) {
  return @{
    @"errorCode" : [NSString stringWithUTF8String:code ? code : "VIDEO_INTERNAL"],
    @"errorMessage" : [NSString stringWithUTF8String:msg.c_str()] ?: @"",
  };
}

}  // namespace

@implementation SherpaOnnx (VideoBuffer)

- (void)createOfflineVideoBufferFromFile:(NSString *)path
                                 options:(NSDictionary *)options
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject {
  (void)options;
  BindVideoModule(self);
  auto r = VideoRegistry::Instance().CreateOfflineFromFile(
      path ? [path UTF8String] : "");
  if (!r.ok()) {
    resolve(VideoError(r.status.errorCode.c_str(), r.status.errorMessage));
    return;
  }
  resolve(VideoInfoDict(r.value->Info()));
}

- (void)createEmptyLiveVideoBuffer:(NSDictionary *)options
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  LiveVideoOptions opts;
  if ([options[@"ringSeconds"] respondsToSelector:@selector(intValue)]) {
    opts.ringSeconds = [options[@"ringSeconds"] intValue];
  }
  const int retention = [options[@"retentionMode"] intValue];
  switch (retention) {
    case 1:
      opts.spool.mode = SpoolRetentionMode::None;
      break;
    case 2:
      opts.spool.mode = SpoolRetentionMode::MaxSeconds;
      break;
    case 3:
      opts.spool.mode = SpoolRetentionMode::Path;
      if ([options[@"retentionPath"] isKindOfClass:[NSString class]]) {
        opts.spool.directory = [options[@"retentionPath"] UTF8String];
      }
      break;
    default:
      opts.spool.mode = SpoolRetentionMode::Session;
      break;
  }
  auto r = VideoRegistry::Instance().CreateLive(opts);
  resolve(VideoInfoDict(r.value->Info()));
}

- (void)ingestFileToLiveVideoBuffer:(NSString *)liveBufferId
                               path:(NSString *)path
                            options:(NSDictionary *)options
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  auto live = VideoRegistry::Instance().GetLive(
      liveBufferId ? [liveBufferId UTF8String] : "");
  if (!live) {
    resolve(VideoError("VIDEO_BUFFER_NOT_FOUND", "live buffer not found"));
    return;
  }
  LiveIngestOptions opts;
  NSString *pacing = options[@"pacing"];
  if ([pacing isEqualToString:@"realtime"]) {
    opts.pacing = sherpa_onnx::video::IngestPacing::Realtime;
  }
  if (options[@"includeAudio"] != nil) {
    opts.includeAudio = [options[@"includeAudio"] boolValue];
  }
  auto st = LiveIngest::Run(path ? [path UTF8String] : "", live.get(), opts);
  if (!st.ok) {
    resolve(VideoError(st.errorCode.c_str(), st.errorMessage));
    return;
  }
  resolve(VideoInfoDict(live->Info()));
}

- (void)finalizeLiveVideoBuffer:(NSString *)liveBufferId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  auto live = VideoRegistry::Instance().GetLive(
      liveBufferId ? [liveBufferId UTF8String] : "");
  if (!live) {
    resolve(VideoError("VIDEO_BUFFER_NOT_FOUND", "live buffer not found"));
    return;
  }
  auto st = live->Finish();
  if (!st.ok) {
    resolve(VideoError(st.errorCode.c_str(), st.errorMessage));
    return;
  }
  resolve(VideoInfoDict(live->Info()));
}

- (void)getVideoBufferInfo:(NSString *)bufferId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  auto e = VideoRegistry::Instance().Get(bufferId ? [bufferId UTF8String] : "");
  if (!e) {
    reject(@"VIDEO_BUFFER_NOT_FOUND", @"video buffer not found", nil);
    return;
  }
  resolve(VideoInfoDict(e->Info()));
}

- (void)getVideoKeyframeTimes:(NSString *)bufferId
                       fromUs:(double)fromUs
                         toUs:(double)toUs
                     maxCount:(double)maxCount
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  auto e = VideoRegistry::Instance().Get(bufferId ? [bufferId UTF8String] : "");
  NSMutableArray *arr = [NSMutableArray array];
  if (e && e->timeline()) {
    auto times = e->timeline()->KeyframeTimes(
        (int64_t)fromUs, (int64_t)toUs, (size_t)MAX(0, (int)maxCount));
    for (int64_t t : times) {
      [arr addObject:@(t)];
    }
  }
  resolve(arr);
}

- (void)configureVideoBuffer:(NSDictionary *)options
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  id budget = options[@"decoderBudget"];
  if ([budget isKindOfClass:[NSDictionary class]]) {
    id cpu = budget[@"cpu"];
    if ([cpu respondsToSelector:@selector(intValue)]) {
      sherpa_onnx::video::DecoderPool::Instance().SetMaxSessions(
          sherpa_onnx::video::DecoderClass::Cpu, [cpu intValue]);
    }
    id display = budget[@"display"];
    if ([display respondsToSelector:@selector(intValue)]) {
      sherpa_onnx::video::DecoderPool::Instance().SetMaxSessions(
          sherpa_onnx::video::DecoderClass::Display, [display intValue]);
    }
  }
  resolve(nil);
}

- (void)startLiveVideoAudioTap:(NSString *)videoBufferId
             liveAudioBufferId:(NSString *)liveAudioBufferId
           targetSampleRateHz:(double)targetSampleRateHz
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  auto entry = VideoRegistry::Instance().Get(
      videoBufferId ? [videoBufferId UTF8String] : "");
  if (!entry) {
    reject(@"VIDEO_BUFFER_NOT_FOUND", @"buffer not found", nil);
    return;
  }
  std::string audioId = liveAudioBufferId ? [liveAudioBufferId UTF8String] : "";
  auto tap = std::make_unique<sherpa_onnx::video::LiveAudioTap>();
  auto st = tap->Start(entry, (int)targetSampleRateHz,
                       [audioId](const float *samples, int n, int sr) {
                         std::string code, msg;
                         pa_append_samples_to_live(audioId, samples,
                                                   static_cast<size_t>(n), sr,
                                                   &code, &msg);
                       });
  if (!st.ok) {
    reject(@(st.errorCode.c_str()), @(st.errorMessage.c_str()), nil);
    return;
  }
  std::string vid = videoBufferId ? [videoBufferId UTF8String] : "";
  {
    std::lock_guard<std::mutex> lock(gLiveAudioTapMu);
    auto it = gLiveAudioTaps.find(vid);
    if (it != gLiveAudioTaps.end()) it->second->Stop();
    gLiveAudioTaps[vid] = std::move(tap);
  }
  resolve(nil);
}

- (void)stopLiveVideoAudioTap:(NSString *)videoBufferId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject {
  std::string vid = videoBufferId ? [videoBufferId UTF8String] : "";
  std::unique_ptr<sherpa_onnx::video::LiveAudioTap> tap;
  {
    std::lock_guard<std::mutex> lock(gLiveAudioTapMu);
    auto it = gLiveAudioTaps.find(vid);
    if (it != gLiveAudioTaps.end()) {
      tap = std::move(it->second);
      gLiveAudioTaps.erase(it);
    }
  }
  if (tap) tap->Stop();
  resolve(nil);
}

- (void)releaseVideoBuffer:(NSString *)bufferId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  VideoRegistry::Instance().Release(bufferId ? [bufferId UTF8String] : "");
  resolve(nil);
}

- (void)createOfflineImageBufferFromVideo:(NSString *)bufferId
                                  options:(NSDictionary *)options
                                  resolve:(RCTPromiseResolveBlock)resolve
                                   reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  ImageBridgeRequest req;
  if ([options[@"sampling"] respondsToSelector:@selector(intValue)]) {
    req.sampling = static_cast<SamplingMode>([options[@"sampling"] intValue]);
  }
  if ([options[@"uniformCount"] respondsToSelector:@selector(intValue)]) {
    req.uniformCount = [options[@"uniformCount"] intValue];
  }
  if ([options[@"fps"] respondsToSelector:@selector(doubleValue)]) {
    req.fps = [options[@"fps"] doubleValue];
  }
  if ([options[@"maxSide"] respondsToSelector:@selector(intValue)]) {
    req.maxSide = [options[@"maxSide"] intValue];
  }
  id times = options[@"timesUs"];
  if ([times isKindOfClass:[NSArray class]]) {
    for (id v in (NSArray *)times) {
      req.timesUs.push_back((int64_t)[v longLongValue]);
    }
  }
  auto r = sherpa_onnx::video::VideoImageBridge::CreateImageBuffer(
      bufferId ? [bufferId UTF8String] : "", req);
  if (!r.status.ok) {
    resolve(VideoError(r.status.errorCode.c_str(), r.status.errorMessage));
    return;
  }
  resolve(@{
    @"imageBufferId" : [NSString stringWithUTF8String:r.imageBufferId.c_str()],
    @"frameCount" : @(r.frameCount),
  });
}

- (void)createOfflineAudioBufferFromVideo:(NSString *)bufferId
                                  options:(NSDictionary *)options
                                  resolve:(RCTPromiseResolveBlock)resolve
                                   reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  NSString *operationId = options[@"operationId"];
  if (![operationId isKindOfClass:[NSString class]] || [operationId length] == 0) {
    operationId = [[NSUUID UUID] UUIDString];
  }
  int64_t startUs = 0;
  int64_t endUs = -1;
  int targetRate = 16000;
  if ([options[@"startUs"] respondsToSelector:@selector(longLongValue)]) {
    startUs = [options[@"startUs"] longLongValue];
  }
  if ([options[@"endUs"] respondsToSelector:@selector(longLongValue)]) {
    endUs = [options[@"endUs"] longLongValue];
  }
  if ([options[@"targetSampleRateHz"] respondsToSelector:@selector(intValue)]) {
    targetRate = [options[@"targetSampleRateHz"] intValue];
  }
  auto cancelFlag = std::make_shared<std::atomic<bool>>(false);
  std::string opId = [operationId UTF8String];
  pa_register_decode_cancel(opId, cancelFlag);
  std::string idStr = bufferId ? [bufferId UTF8String] : "";
  __weak SherpaOnnx *weakSelf = self;
  NSString *opIdNs = operationId;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    auto e = VideoRegistry::Instance().Get(idStr);
    if (!e) {
      pa_unregister_decode_cancel(opId);
      dispatch_async(dispatch_get_main_queue(), ^{
        reject(@"VIDEO_BUFFER_NOT_FOUND", @"extract", nil);
      });
      return;
    }
    NSString *outF32 = [NSTemporaryDirectory()
        stringByAppendingPathComponent:
            [NSString stringWithFormat:@"vid_aud_%s.f32",
                                       sherpa_onnx::video::UuidV4().c_str()]];
    sherpa_onnx::video::AudioExtractOptions opts;
    opts.rangeStartUs = startUs;
    opts.rangeEndUs = endUs;
    opts.targetSampleRate = targetRate;
    sherpa_onnx::video::AudioExtractResult result;
    auto st = sherpa_onnx::video::VideoAudioExtractor::Run(
        e, opts, [outF32 UTF8String], cancelFlag.get(),
        [weakSelf, opIdNs](int percent, int64_t decodedMs) {
          SherpaOnnx *strongSelf = weakSelf;
          if (!strongSelf) return;
          dispatch_async(dispatch_get_main_queue(), ^{
            [strongSelf sendEventWithName:@"decodeProgress"
                                     body:@{
                                       @"operationId" : opIdNs,
                                       @"framesDecoded" : @((double)decodedMs),
                                       @"totalFramesEstimate" : @(0),
                                       @"percent" : @(percent),
                                       @"sourceSampleRate" : @(0),
                                       @"sourceChannels" : @(0),
                                     }];
          });
        },
        &result);
    if (!st.ok) {
      pa_unregister_decode_cancel(opId);
      NSString *code = [NSString stringWithUTF8String:st.errorCode.c_str()];
      NSString *msg = [NSString stringWithUTF8String:st.errorMessage.c_str()];
      dispatch_async(dispatch_get_main_queue(), ^{
        reject(code, msg, nil);
      });
      return;
    }
    std::string audioId;
    std::string errCode;
    std::string errMsg;
    if (!pa_create_offline_from_f32_file(result.path, result.sampleRate, 1,
                                         &audioId, &errCode, &errMsg)) {
      pa_unregister_decode_cancel(opId);
      unlink(result.path.c_str());
      dispatch_async(dispatch_get_main_queue(), ^{
        reject([NSString stringWithUTF8String:errCode.c_str()],
               [NSString stringWithUTF8String:errMsg.c_str()], nil);
      });
      return;
    }
    pa_unregister_decode_cancel(opId);
    double durationMs =
        result.sampleRate > 0
            ? (double)result.numSamples / (double)result.sampleRate * 1000.0
            : 0;
    dispatch_async(dispatch_get_main_queue(), ^{
      resolve(@{
        @"bufferId" : [NSString stringWithUTF8String:audioId.c_str()],
        @"kind" : @"offlinePcmBuffer",
        @"state" : @"immutable",
        @"sampleRate" : @(result.sampleRate),
        @"channelCount" : @(1),
        @"numSamples" : @(result.numSamples),
        @"durationMs" : @(durationMs),
        @"mediaStartMs" : @(result.mediaStartUs / 1000.0),
        @"sourceCodec" : [NSString stringWithUTF8String:result.sourceCodec.c_str()]
            ?: @"",
        @"sourceSampleRate" : @(result.sourceSampleRate),
        @"sourceChannels" : @(result.sourceChannels),
      });
    });
  });
}

@end
