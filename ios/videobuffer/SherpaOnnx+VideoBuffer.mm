#import "SherpaOnnx.h"
#import "../fileio/FileIOResolver.h"

#include "VideoImageBridge.h"
#include "VideoLog.h"
#include "VideoRegistry.h"
#include "demux/FfmpegProbe.h"
#include "encode/EncoderBackend.h"
#include "encode/VideoExportSession.h"
#include "audio/LiveAudioTap.h"
#include "audio/VideoAudioExtractor.h"
#include "core/Uuid.h"
#include "../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "codec/CodecCatalog.h"
#include "codec/CodecEvents.h"
#include "codec/CodecRuntime.h"
#include "codec/CodecTypes.h"
#include "decode/DecoderBackend.h"
#include "decode/DecoderPool.h"
#include "live/LiveIngest.h"
#include "live/LiveVideoEntry.h"

#import "SherpaOnnx+VideoModule.h"
#import "VideoMemoryPressure.h"
#import "VideoToolboxDecoder.h"
#import "VideoToolboxEncoder.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <optional>
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
using sherpa_onnx::video::VideoToolboxEncoder;

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
    sherpa_onnx::video::RegisterEncoderFactory([]() {
      return std::unique_ptr<sherpa_onnx::video::EncoderBackend>(
          new VideoToolboxEncoder());
    });
    sherpa_onnx::video::SetNamedDecoderOpener([](const std::string& name) {
      const auto mode = name.find(".sw") != std::string::npos
                            ? VideoToolboxDecoder::Mode::Software
                            : VideoToolboxDecoder::Mode::Hardware;
      return std::unique_ptr<sherpa_onnx::video::DecoderBackend>(
          new VideoToolboxDecoder(mode));
    });
    sherpa_onnx::video::SetNamedEncoderOpener([](const std::string& name) {
      const auto mode = name.find(".sw") != std::string::npos
                            ? VideoToolboxEncoder::Mode::Software
                            : VideoToolboxEncoder::Mode::Hardware;
      return std::unique_ptr<sherpa_onnx::video::EncoderBackend>(
          new VideoToolboxEncoder(mode));
    });
    {
      using sherpa_onnx::codec::CodecCatalog;
      using sherpa_onnx::codec::Direction;
      using sherpa_onnx::codec::Media;
      using sherpa_onnx::codec::Origin;
      using sherpa_onnx::codec::Provider;
      using sherpa_onnx::codec::Reason;
      using sherpa_onnx::codec::Tier;
      const bool ios17 = @available(iOS 17.0, *);
      const bool ios174 = @available(iOS 17.4, *);
      auto add = [&](const char* name, const char* codec, Direction dir,
                     Tier tier, bool avail, Reason reason) {
        Provider p;
        p.media = Media::Video;
        p.dir = dir;
        p.codec = codec;
        p.tier = tier;
        p.origin = Origin::Platform;
        p.name = name;
        p.caps.maxW = 8192;
        p.caps.maxH = 8192;
        p.available = avail;
        p.unavailableReason = reason;
        CodecCatalog::Instance().Register(std::move(p));
      };
      for (const char* codec : {"h264", "hevc"}) {
        add("vt.hw", codec, Direction::Decode,
            ios17 ? Tier::Hardware : Tier::Unknown, true, Reason::None);
        add("vt.sw", codec, Direction::Decode, Tier::Software, ios17,
            ios17 ? Reason::None : Reason::OsTooOld);
        add("vt.hw", codec, Direction::Encode,
            ios174 ? Tier::Hardware : Tier::Unknown, true, Reason::None);
        add("vt.sw", codec, Direction::Encode, Tier::Software, ios174,
            ios174 ? Reason::None : Reason::OsTooOld);
      }
    }
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
    sherpa_onnx::codec::SetEventSink([](const std::string &json) {
      SherpaOnnx *mod = gVideoModule;
      if (mod == nil) return;
      [mod sendEventWithName:@"SherpaOnnxCodecEvent"
                        body:@{
                          @"type" : @"codec",
                          @"payload" : [NSString stringWithUTF8String:json.c_str()]
                              ?: @"",
                        }];
    });
  });
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
  if (!info.decoderJson.empty()) {
    dict[@"decoder"] = [NSString stringWithUTF8String:info.decoderJson.c_str()];
  }
  return dict;
}

std::optional<sherpa_onnx::codec::Policy> PolicyFromDict(NSDictionary *options,
                                                         NSString *key) {
  if (![options isKindOfClass:[NSDictionary class]]) return std::nullopt;
  id raw = options[key];
  if (![raw isKindOfClass:[NSString class]]) return std::nullopt;
  return sherpa_onnx::codec::ParsePolicy([(NSString *)raw UTF8String]);
}

NSDictionary *VideoError(const char *code, const std::string &msg) {
  return @{
    @"errorCode" : [NSString stringWithUTF8String:code ? code : "VIDEO_INTERNAL"],
    @"errorMessage" : [NSString stringWithUTF8String:msg.c_str()] ?: @"",
  };
}

}  // namespace

void BindVideoModule(SherpaOnnx *mod) {
  gVideoModule = mod;
  EnsureVideoInit();
}

@implementation SherpaOnnx (VideoBuffer)

- (void)runVideoFileProbe:(NSDictionary *)source
             durationOnly:(BOOL)durationOnly
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  if (![source isKindOfClass:[NSDictionary class]]) {
    reject(@"VIDEO_INVALID_ARGUMENT", @"source must be a FileSource", nil);
    return;
  }
  NSString *errCode = nil;
  NSString *errMsg = nil;
  FileIOReadHandle *readHandle = [FileIOResolver resolveSource:source
                                                         error:&errCode
                                                       message:&errMsg];
  if (!readHandle) {
    reject(errCode ?: @"VIDEO_INVALID_ARGUMENT",
           errMsg ?: @"Failed to resolve FileSource", nil);
    return;
  }
  NSString *path = [FileIOResolver demuxableFilePathFromHandle:readHandle
                                                        source:source
                                                         error:&errCode
                                                       message:&errMsg];
  if (path.length == 0) {
    [readHandle cleanup];
    reject(errCode ?: @"VIDEO_INVALID_ARGUMENT",
           errMsg ?: @"FileSource is not a readable file", nil);
    return;
  }
  sherpa_onnx::video::VideoFileProbe probe;
  auto st = sherpa_onnx::video::ProbeVideoFile([path UTF8String], &probe);
  [readHandle cleanup];
  if ([FileIOResolver isNofdCachePath:path]) {
    [FileIOResolver unpinNofdPath:path];
  }
  if (!st.ok) {
    reject([NSString stringWithUTF8String:st.errorCode.c_str()] ?: @"VIDEO_INTERNAL",
           [NSString stringWithUTF8String:st.errorMessage.c_str()] ?: @"probe failed",
           nil);
    return;
  }
  if (durationOnly) {
    resolve(@{
      @"durationUs" : @(probe.durationUs),
      @"isExact" : @(probe.durationExact),
    });
    return;
  }
  NSMutableDictionary *dict = [@{
    @"inputFormatName" : [NSString stringWithUTF8String:probe.inputFormatName.c_str()]
        ?: @"unknown",
    @"codecName" : [NSString stringWithUTF8String:probe.codecName.c_str()] ?: @"unknown",
    @"codedWidth" : @(probe.codedWidth),
    @"codedHeight" : @(probe.codedHeight),
  } mutableCopy];
  if (probe.audioCodecName && !probe.audioCodecName->empty()) {
    dict[@"audioCodecName"] =
        [NSString stringWithUTF8String:probe.audioCodecName->c_str()];
  }
  resolve(dict);
}

- (void)probeVideoFileDuration:(NSDictionary *)source
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject {
  [self runVideoFileProbe:source durationOnly:YES resolve:resolve reject:reject];
}

- (void)probeVideoFileContainer:(NSDictionary *)source
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject {
  [self runVideoFileProbe:source durationOnly:NO resolve:resolve reject:reject];
}

- (void)createOfflineVideoBufferFromFile:(NSDictionary *)source
                                 options:(NSDictionary *)options
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  if (![source isKindOfClass:[NSDictionary class]]) {
    reject(@"VIDEO_INVALID_ARGUMENT", @"source must be a FileSource", nil);
    return;
  }
  NSString *errCode = nil;
  NSString *errMsg = nil;
  FileIOReadHandle *readHandle = [FileIOResolver resolveSource:source
                                                         error:&errCode
                                                       message:&errMsg];
  if (!readHandle) {
    reject(errCode ?: @"VIDEO_INVALID_ARGUMENT",
           errMsg ?: @"Failed to resolve FileSource", nil);
    return;
  }
  NSString *path = [FileIOResolver demuxableFilePathFromHandle:readHandle
                                                        source:source
                                                         error:&errCode
                                                       message:&errMsg];
  if (path.length == 0) {
    [readHandle cleanup];
    reject(errCode ?: @"VIDEO_INVALID_ARGUMENT",
           errMsg ?: @"FileSource is not a readable file", nil);
    return;
  }
  VIDEO_LOGI("video.file createOfflineFromFile kind=%s path=%s",
             [[source[@"kind"] description] UTF8String] ?: "?",
             [path UTF8String]);
  auto r = VideoRegistry::Instance().CreateOfflineFromFile([path UTF8String]);
  [readHandle cleanup];
  if (!r.ok()) {
    if ([FileIOResolver isNofdCachePath:path]) {
      [FileIOResolver unpinNofdPath:path];
    }
    resolve(VideoError(r.status.errorCode.c_str(), r.status.errorMessage));
    return;
  }
  if ([FileIOResolver isNofdCachePath:path]) {
    NSString *bid = [NSString stringWithUTF8String:r.value->id().c_str()];
    [FileIOResolver retainNofdPinForBuffer:bid path:path];
  }
  r.value->SetDecodePolicy(PolicyFromDict(options, @"decodePolicy"));
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
  if (r.ok() && r.value) {
    r.value->SetDecodePolicy(PolicyFromDict(options, @"decodePolicy"));
  }
  resolve(VideoInfoDict(r.value->Info()));
}

- (void)ingestFileToLiveVideoBuffer:(NSString *)liveBufferId
                             source:(NSDictionary *)source
                            options:(NSDictionary *)options
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  if (![source isKindOfClass:[NSDictionary class]]) {
    reject(@"VIDEO_INVALID_ARGUMENT", @"source must be a FileSource", nil);
    return;
  }
  auto live = VideoRegistry::Instance().GetLive(
      liveBufferId ? [liveBufferId UTF8String] : "");
  if (!live) {
    resolve(VideoError("VIDEO_BUFFER_NOT_FOUND", "live buffer not found"));
    return;
  }
  NSString *errCode = nil;
  NSString *errMsg = nil;
  FileIOReadHandle *readHandle = [FileIOResolver resolveSource:source
                                                         error:&errCode
                                                       message:&errMsg];
  if (!readHandle) {
    reject(errCode ?: @"VIDEO_INVALID_ARGUMENT",
           errMsg ?: @"Failed to resolve FileSource", nil);
    return;
  }
  NSString *path = [FileIOResolver demuxableFilePathFromHandle:readHandle
                                                        source:source
                                                         error:&errCode
                                                       message:&errMsg];
  if (path.length == 0) {
    [readHandle cleanup];
    reject(errCode ?: @"VIDEO_INVALID_ARGUMENT",
           errMsg ?: @"FileSource is not a readable file", nil);
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
  VIDEO_LOGI("video.file ingestFile live=%s kind=%s path=%s",
             liveBufferId ? [liveBufferId UTF8String] : "",
             [[source[@"kind"] description] UTF8String] ?: "?",
             [path UTF8String]);
  auto st = LiveIngest::Run([path UTF8String], live.get(), opts);
  [readHandle cleanup];
  if ([FileIOResolver isNofdCachePath:path]) {
    [FileIOResolver unpinNofdPath:path];
  }
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
  (void)options;
  BindVideoModule(self);
  resolve(nil);
}

- (void)configureCodecs:(NSDictionary *)options
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  EnsureVideoInit();
  NSDictionary *video = [options isKindOfClass:[NSDictionary class]]
                            ? options[@"video"]
                            : nil;
  NSDictionary *image = [options isKindOfClass:[NSDictionary class]]
                            ? options[@"image"]
                            : nil;
  NSDictionary *budgets = [options isKindOfClass:[NSDictionary class]]
                              ? options[@"budgets"]
                              : nil;
  auto cstr = [](id v) -> const char * {
    if (![v isKindOfClass:[NSString class]]) return nullptr;
    return [v UTF8String];
  };
  auto nint = [](id v) -> int {
    if ([v respondsToSelector:@selector(intValue)]) return [v intValue];
    return 0;
  };
  int b[6] = {
      nint(budgets[@"hwVideoDecode"]), nint(budgets[@"hwVideoDisplay"]),
      nint(budgets[@"hwVideoEncode"]),  nint(budgets[@"swVideoDecode"]),
      nint(budgets[@"swVideoEncode"]),  nint(budgets[@"platformImageDecode"]),
  };
  auto st = sherpa_onnx::codec::CodecRuntime::Instance().ConfigureFromNative(
      cstr(video[@"decode"]), cstr(video[@"display"]), cstr(video[@"encode"]),
      cstr(image[@"decode"]), b);
  if (b[0] > 0) {
    sherpa_onnx::video::DecoderPool::Instance().SetMaxSessions(
        sherpa_onnx::video::DecoderClass::Cpu, b[0]);
  }
  if (b[1] > 0) {
    sherpa_onnx::video::DecoderPool::Instance().SetMaxSessions(
        sherpa_onnx::video::DecoderClass::Display, b[1]);
  }
  if (!st.ok) {
    reject([NSString stringWithUTF8String:st.errorCode.c_str()],
           [NSString stringWithUTF8String:st.errorMessage.c_str()], nil);
    return;
  }
  resolve(nil);
}

- (void)getCodecInfo:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  EnsureVideoInit();
  const std::string json =
      sherpa_onnx::codec::CodecRuntime::Instance().InfoJson();
  resolve([NSString stringWithUTF8String:json.c_str()]);
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
  if (bufferId.length > 0) {
    [FileIOResolver releaseNofdPinForBuffer:bufferId];
  }
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

- (void)exportVideo:(NSString *)bufferId
        destination:(NSDictionary *)destination
             format:(NSString *)format
            options:(NSDictionary *)options
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  NSString *operationId = options[@"operationId"];
  if (![operationId isKindOfClass:[NSString class]] || [operationId length] == 0) {
    operationId = [[NSUUID UUID] UUIDString];
  }
  NSString *codecStr = [(options[@"codec"] ?: @"h264") lowercaseString];
  int bitrate = 2000000;
  if ([options[@"bitrate"] respondsToSelector:@selector(intValue)]) {
    bitrate = [options[@"bitrate"] intValue];
  }
  int64_t fromUs = 0;
  int64_t toUs = -1;
  int maxSide = 0;
  if ([options[@"fromUs"] respondsToSelector:@selector(longLongValue)]) {
    fromUs = [options[@"fromUs"] longLongValue];
  }
  if ([options[@"toUs"] respondsToSelector:@selector(longLongValue)]) {
    toUs = [options[@"toUs"] longLongValue];
  }
  if ([options[@"maxSide"] respondsToSelector:@selector(intValue)]) {
    maxSide = [options[@"maxSide"] intValue];
  }
  NSString *fmt = [(format ?: @"mp4") lowercaseString];
  NSString *errCode = nil;
  NSString *errMsg = nil;
  FileIOWriteHandle *wh =
      [FileIOResolver resolveDestination:destination
                               overwrite:YES
                  createParentDirectories:YES
                                    error:&errCode
                                  message:&errMsg];
  if (!wh || wh.filePath.length == 0) {
    reject(errCode ?: @"VIDEO_INVALID_ARGUMENT",
           errMsg ?: @"Failed to resolve FileDestination", nil);
    return;
  }

  auto cancelFlag = std::make_shared<std::atomic<bool>>(false);
  std::string opId = [operationId UTF8String];
  pa_register_decode_cancel(opId, cancelFlag);
  std::string idStr = bufferId ? [bufferId UTF8String] : "";
  std::string pathStr = [wh.filePath UTF8String];
  std::string formatStr = [fmt UTF8String];
  sherpa_onnx::video::VideoExportOptions opts;
  opts.codec = [codecStr isEqualToString:@"hevc"]
                   ? sherpa_onnx::video::VideoCodec::Hevc
                   : sherpa_onnx::video::VideoCodec::H264;
  opts.bitrate = bitrate;
  opts.fromUs = fromUs;
  opts.toUs = toUs;
  opts.maxSide = maxSide;
  opts.decodePolicy = PolicyFromDict(options, @"decodePolicy");
  opts.encodePolicy = PolicyFromDict(options, @"encodePolicy");
  __weak SherpaOnnx *weakSelf = self;
  NSString *opIdNs = operationId;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    auto st = sherpa_onnx::video::VideoExportSession::Run(
        idStr, pathStr, formatStr, opts, cancelFlag.get(),
        [weakSelf, opIdNs](int percent, int64_t encodedUs) {
          SherpaOnnx *strongSelf = weakSelf;
          if (!strongSelf) return;
          dispatch_async(dispatch_get_main_queue(), ^{
            [strongSelf sendEventWithName:@"decodeProgress"
                                     body:@{
                                       @"operationId" : opIdNs,
                                       @"percent" : @(percent),
                                       @"encodedUs" : @((double)encodedUs),
                                       @"framesDecoded" : @((double)encodedUs),
                                       @"totalFramesEstimate" : @(0),
                                       @"sourceSampleRate" : @(0),
                                       @"sourceChannels" : @(0),
                                     }];
          });
        });
    pa_unregister_decode_cancel(opId);
    if (!st.ok) {
      [wh cleanup];
      [[NSFileManager defaultManager] removeItemAtPath:wh.filePath error:nil];
      NSString *code = [NSString stringWithUTF8String:st.errorCode.c_str()];
      NSString *msg = [NSString stringWithUTF8String:st.errorMessage.c_str()];
      dispatch_async(dispatch_get_main_queue(), ^{
        reject(code, msg, nil);
      });
      return;
    }
    NSString *resultPath = wh.resultPath.length > 0 ? wh.resultPath : wh.filePath;
    [wh cleanup];
    NSMutableDictionary *out = [@{
      @"outputKind" : @"fs",
      @"outputPath" : resultPath ?: wh.filePath,
    } mutableCopy];
    if (!opts.decoderDecision.provider.empty()) {
      out[@"decoder"] = [NSString stringWithUTF8String:
          sherpa_onnx::codec::DecisionToJson(opts.decoderDecision).c_str()];
    }
    if (!opts.encoderDecision.provider.empty()) {
      out[@"encoder"] = [NSString stringWithUTF8String:
          sherpa_onnx::codec::DecisionToJson(opts.encoderDecision).c_str()];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      resolve(out);
    });
  });
}

@end
