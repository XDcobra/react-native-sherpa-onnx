#import "SherpaOnnx.h"
#import "PaAudioSessionCoordinator.h"
#import "videobuffer/SherpaOnnx+VideoModule.h"

#include "SampleBufferAudioRenderer.h"
#include "VideoRegistry.h"
#include "codec/CodecTypes.h"
#include "preview/PreviewPlayer.h"

#include <string>

using sherpa_onnx::video::VideoKind;
using sherpa_onnx::video::VideoRegistry;
using sherpa_onnx::video::preview::AudioDecision;
using sherpa_onnx::video::preview::PreviewInput;
using sherpa_onnx::video::preview::PreviewInputKind;
using sherpa_onnx::video::preview::PreviewPlayerOptions;
using sherpa_onnx::video::preview::PreviewRegistry;
using sherpa_onnx::video::preview::SampleBufferAudioRenderer;
using sherpa_onnx::video::preview::SynchronizerClock;
using sherpa_onnx::video::SeekMode;

namespace {

AudioDecision DecideAudio(const sherpa_onnx::video::VideoBufferInfo &info, bool off) {
  if (off) return AudioDecision::Off;
  if (!info.audio) return AudioDecision::Absent;
  if (!info.audio->decodable) return AudioDecision::Unsupported;
  return AudioDecision::Track;
}

id JsonToId(NSString *json) {
  if (json.length == 0) return @{};
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  id obj = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return obj ?: @{};
}

SeekMode ParseMode(NSString *mode) {
  if ([mode isEqualToString:@"keyframe"]) return SeekMode::Keyframe;
  if ([mode isEqualToString:@"closestKeyframe"]) return SeekMode::ClosestKeyframe;
  return SeekMode::Accurate;
}

void InstallPreviewSink(SherpaOnnx *mod) {
  PreviewRegistry::Instance().SetEventSink(
      [mod](const std::string &type, const std::string &playerId,
            const std::string &json) {
        NSString *t = [NSString stringWithUTF8String:type.c_str()];
        NSString *pid = [NSString stringWithUTF8String:playerId.c_str()];
        NSString *js = [NSString stringWithUTF8String:json.c_str()];
        id payload = JsonToId(js);
        [mod sendEventWithName:@"SherpaOnnxVideoPreviewEvent"
                          body:@{
                            @"type" : t ?: @"",
                            @"playerId" : pid ?: @"",
                            @"payload" : payload ?: @{},
                          }];
      });
}

}  // namespace

@implementation SherpaOnnx (VideoPreview)

- (void)createVideoPreviewPlayer:(NSString *)bufferId
                         options:(NSDictionary *)options
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject {
  BindVideoModule(self);
  InstallPreviewSink(self);
  auto entry = VideoRegistry::Instance().Get(bufferId ? [bufferId UTF8String] : "");
  if (!entry) {
    reject(@"VIDEO_BUFFER_NOT_FOUND", @"buffer not found", nil);
    return;
  }
  auto info = entry->Info();
  BOOL audioOff = [options[@"audio"][@"source"] isEqualToString:@"none"];
  BOOL required = [options[@"audio"][@"required"] boolValue];
  PreviewPlayerOptions popts;
  popts.controller.isLive = info.kind == VideoKind::Live;
  popts.audioDecision = DecideAudio(info, audioOff);
  popts.controller.audioOff = audioOff;
  popts.controller.audioRequired = required;
  popts.controller.loop = [options[@"loop"] boolValue];
  popts.controller.pauseOnBackground = options[@"pauseOnBackground"] == nil ||
                                       [options[@"pauseOnBackground"] boolValue];
  popts.muted = [options[@"muted"] boolValue];
  if ([options[@"decodePolicy"] isKindOfClass:[NSString class]]) {
    popts.decodePolicy =
        sherpa_onnx::codec::ParsePolicy([options[@"decodePolicy"] UTF8String]);
  }
  if (options[@"progressIntervalMs"] != nil) {
    int interval = [options[@"progressIntervalMs"] intValue];
    if (interval < 50) interval = 50;
    if (interval > 5000) interval = 5000;
    popts.progressIntervalMs = interval;
  }
  if (required && popts.audioDecision != AudioDecision::Track) {
    reject(@"VIDEO_PREVIEW_AUDIO_UNSUPPORTED", @"audio required but not playable",
           nil);
    return;
  }
  auto player = PreviewRegistry::Instance().Create(entry, popts);
  if (popts.audioDecision == AudioDecision::Track) {
    auto ar = std::make_unique<SampleBufferAudioRenderer>();
    int sr = info.audio ? info.audio->sampleRate : 48000;
    int ch = info.audio ? info.audio->channels : 2;
    (void)ar->Open(sr, ch);
    auto* sync = ar->synchronizer();
    player->SetClock(std::make_unique<SynchronizerClock>(sync));
    NSString *owner =
        [NSString stringWithFormat:@"vprev:%s", player->id().c_str()];
    [[PaAudioSessionCoordinator shared]
        acquireIntent:[PaAudioSessionIntent intentWithOwnerId:owner
                                                   needsInput:NO
                                                  needsOutput:YES]];
    player->TakeAudioRenderer(std::move(ar));
  }
  PreviewInput prep;
  prep.kind = PreviewInputKind::Prepare;
  player->Post(prep, 0);
  PreviewInput prepared;
  prepared.kind = PreviewInputKind::Prepared;
  player->Post(prepared, 0);
  resolve(JsonToId([NSString stringWithUTF8String:player->SnapshotJson().c_str()]));
}

- (void)videoPreviewPlay:(NSString *)playerId
               requestId:(NSString *)requestId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  auto p = PreviewRegistry::Instance().Get(playerId ? [playerId UTF8String] : "");
  if (!p) {
    reject(@"VIDEO_PREVIEW_NOT_FOUND", @"player not found", nil);
    return;
  }
  PreviewInput in;
  in.kind = PreviewInputKind::Play;
  auto r = p->Post(in, p->state().positionUs);
  if (!r.status.ok) {
    reject(@(r.status.errorCode.c_str()), @(r.status.errorMessage.c_str()), nil);
    return;
  }
  resolve(JsonToId([NSString stringWithUTF8String:p->SnapshotJson().c_str()]));
}

- (void)videoPreviewPause:(NSString *)playerId
                requestId:(NSString *)requestId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  auto p = PreviewRegistry::Instance().Get(playerId ? [playerId UTF8String] : "");
  if (!p) {
    reject(@"VIDEO_PREVIEW_NOT_FOUND", @"player not found", nil);
    return;
  }
  PreviewInput in;
  in.kind = PreviewInputKind::Pause;
  auto r = p->Post(in, p->state().positionUs);
  if (!r.status.ok) {
    reject(@(r.status.errorCode.c_str()), @(r.status.errorMessage.c_str()), nil);
    return;
  }
  resolve(JsonToId([NSString stringWithUTF8String:p->SnapshotJson().c_str()]));
}

- (void)videoPreviewSeek:(NSString *)playerId
              positionMs:(double)positionMs
                    mode:(NSString *)mode
                relative:(BOOL)relative
               requestId:(NSString *)requestId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  auto p = PreviewRegistry::Instance().Get(playerId ? [playerId UTF8String] : "");
  if (!p) {
    reject(@"VIDEO_PREVIEW_NOT_FOUND", @"player not found", nil);
    return;
  }
  PreviewInput in;
  in.kind = PreviewInputKind::Seek;
  in.mode = ParseMode(mode);
  int64_t tUs = (int64_t)(positionMs * 1000.0);
  if (relative) tUs = p->state().positionUs + tUs;
  in.tUs = tUs;
  auto r = p->Post(in, p->state().positionUs);
  if (!r.status.ok) {
    reject(@(r.status.errorCode.c_str()), @(r.status.errorMessage.c_str()), nil);
    return;
  }
  resolve(@{
    @"status" : @"completed",
    @"requestedMs" : @(positionMs),
    @"actualMs" : @(p->state().positionUs / 1000.0),
  });
}

- (void)videoPreviewSeekToLiveEdge:(NSString *)playerId
                         requestId:(NSString *)requestId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject {
  auto p = PreviewRegistry::Instance().Get(playerId ? [playerId UTF8String] : "");
  if (!p) {
    reject(@"VIDEO_PREVIEW_NOT_FOUND", @"player not found", nil);
    return;
  }
  PreviewInput in;
  in.kind = PreviewInputKind::SeekLiveEdge;
  auto r = p->Post(in, p->state().positionUs);
  if (!r.status.ok) {
    reject(@(r.status.errorCode.c_str()), @(r.status.errorMessage.c_str()), nil);
    return;
  }
  resolve(@{
    @"status" : @"completed",
    @"requestedMs" : @(p->state().liveEdgeUs / 1000.0),
    @"actualMs" : @(p->state().positionUs / 1000.0),
  });
}

- (void)videoPreviewStepFrame:(NSString *)playerId
                    direction:(double)direction
                    requestId:(NSString *)requestId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject {
  auto p = PreviewRegistry::Instance().Get(playerId ? [playerId UTF8String] : "");
  if (!p) {
    reject(@"VIDEO_PREVIEW_NOT_FOUND", @"player not found", nil);
    return;
  }
  PreviewInput in;
  in.kind = PreviewInputKind::StepFrame;
  in.stepDir = direction < 0 ? -1 : 1;
  auto r = p->Post(in, p->state().positionUs);
  if (!r.status.ok) {
    reject(@(r.status.errorCode.c_str()), @(r.status.errorMessage.c_str()), nil);
    return;
  }
  resolve(@{
    @"status" : @"completed",
    @"requestedMs" : @(p->state().positionUs / 1000.0),
    @"actualMs" : @(p->state().positionUs / 1000.0),
  });
}

- (void)videoPreviewSetVolume:(NSString *)playerId
                       volume:(double)volume
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject {
  auto p = PreviewRegistry::Instance().Get(playerId ? [playerId UTF8String] : "");
  if (!p) {
    reject(@"VIDEO_PREVIEW_NOT_FOUND", @"player not found", nil);
    return;
  }
  p->SetVolume((float)volume);
  resolve(nil);
}

- (void)videoPreviewSetMuted:(NSString *)playerId
                       muted:(BOOL)muted
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject {
  auto p = PreviewRegistry::Instance().Get(playerId ? [playerId UTF8String] : "");
  if (!p) {
    reject(@"VIDEO_PREVIEW_NOT_FOUND", @"player not found", nil);
    return;
  }
  p->SetMuted(muted);
  resolve(nil);
}

- (void)videoPreviewSetLoop:(NSString *)playerId
                       loop:(BOOL)loop
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  auto p = PreviewRegistry::Instance().Get(playerId ? [playerId UTF8String] : "");
  if (!p) {
    reject(@"VIDEO_PREVIEW_NOT_FOUND", @"player not found", nil);
    return;
  }
  p->SetLoop(loop);
  resolve(nil);
}

- (void)videoPreviewSnapshot:(NSString *)playerId
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject {
  auto p = PreviewRegistry::Instance().Get(playerId ? [playerId UTF8String] : "");
  if (!p) {
    reject(@"VIDEO_PREVIEW_NOT_FOUND", @"player not found", nil);
    return;
  }
  resolve(JsonToId([NSString stringWithUTF8String:p->SnapshotJson().c_str()]));
}

- (void)releaseVideoPreviewPlayer:(NSString *)playerId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject {
  if (playerId.length > 0) {
    NSString *owner = [NSString stringWithFormat:@"vprev:%@", playerId];
    [[PaAudioSessionCoordinator shared] releaseIntent:owner];
    PreviewRegistry::Instance().Release([playerId UTF8String]);
  }
  resolve(nil);
}

@end
