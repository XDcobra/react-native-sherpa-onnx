#import "SherpaOnnx.h"

#include "VideoImageBridge.h"
#include "VideoLog.h"
#include "VideoRegistry.h"
#include "decode/DecoderBackend.h"
#include "live/LiveIngest.h"
#include "live/LiveVideoEntry.h"

#import "VideoToolboxDecoder.h"

#include <memory>
#include <mutex>
#include <string>
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
  return @{
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
  };
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

@end
