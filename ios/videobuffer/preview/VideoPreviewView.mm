#import "VideoPreviewView.h"

#import <AVFoundation/AVFoundation.h>

#include "DecodedSampleBufferRenderer.h"
#include "SampleBufferAudioRenderer.h"
#include "SampleBufferVideoRenderer.h"
#include "VideoRegistry.h"
#include "codec/CodecCatalog.h"
#include "codec/CodecPolicy.h"
#include "codec/CodecRuntime.h"
#include "codec/CodecTypes.h"
#include "decode/DecoderBackend.h"
#include "preview/PreviewPlayer.h"

using sherpa_onnx::video::OpenDecoderForProvider;
using sherpa_onnx::video::VideoCodecName;
using sherpa_onnx::video::preview::DecodedSampleBufferRenderer;
using sherpa_onnx::video::preview::PreviewInput;
using sherpa_onnx::video::preview::PreviewInputKind;
using sherpa_onnx::video::preview::PreviewRegistry;
using sherpa_onnx::video::preview::SampleBufferVideoRenderer;
using sherpa_onnx::video::preview::SampleBufferAudioRenderer;

@implementation VideoPreviewView {
  /** Player the renderer was created for (attach once per player). */
  NSString *_attachedPlayerId;
}

+ (Class)layerClass {
  return [AVSampleBufferDisplayLayer class];
}

- (AVSampleBufferDisplayLayer *)displayLayer {
  return (AVSampleBufferDisplayLayer *)self.layer;
}

- (void)dealloc {
  [self detachFromPlayer];
}

// The player's renderer draws into this view's layer without owning it: drop
// the renderer before the layer can go away (the pump thread otherwise calls
// into a freed AVSampleBufferDisplayLayer).
- (void)detachFromPlayer {
  if (_attachedPlayerId.length > 0) {
    auto p = PreviewRegistry::Instance().Get([_attachedPlayerId UTF8String]);
    if (p) p->DetachVideoRenderer();
  }
  _attachedPlayerId = nil;
}

- (void)setPlayerId:(NSString *)playerId {
  if ([_playerId isEqualToString:playerId]) return;
  [self detachFromPlayer];
  _playerId = [playerId copy];
  [self attachIfPossible];
}

- (void)setResizeMode:(NSString *)resizeMode {
  _resizeMode = [resizeMode copy];
  NSString *mode = resizeMode.lowercaseString ?: @"contain";
  if ([mode isEqualToString:@"cover"]) {
    self.displayLayer.videoGravity = AVLayerVideoGravityResizeAspectFill;
  } else if ([mode isEqualToString:@"stretch"]) {
    self.displayLayer.videoGravity = AVLayerVideoGravityResize;
  } else {
    self.displayLayer.videoGravity = AVLayerVideoGravityResizeAspect;
  }
}

- (void)didMoveToWindow {
  [super didMoveToWindow];
  if (self.window == nil) {
    // Unmounted, recycled or off screen; reattached when it comes back.
    [self detachFromPlayer];
    return;
  }
  [self attachIfPossible];
}

- (void)attachIfPossible {
  if (self.playerId.length == 0) return;
  // setPlayerId and didMoveToWindow both land here; attach once, and only on
  // screen. Re-attaching built a second renderer and decoder for nothing.
  if (self.window == nil) return;
  if ([_attachedPlayerId isEqualToString:self.playerId]) return;
  auto p = PreviewRegistry::Instance().Get([self.playerId UTF8String]);
  if (!p) return;
  _attachedPlayerId = [self.playerId copy];

  bool software = false;
  std::string providerName;
  if (p->entry() && p->entry()->packets()) {
    const auto& track = p->entry()->packets()->track();
    sherpa_onnx::codec::Request req;
    req.media = sherpa_onnx::codec::Media::Video;
    req.dir = sherpa_onnx::codec::Direction::Decode;
    req.use = sherpa_onnx::codec::Use::Display;
    req.stream.codec = VideoCodecName(track.codec);
    req.stream.width = track.codedWidth;
    req.stream.height = track.codedHeight;
    req.policy = sherpa_onnx::codec::CodecRuntime::Instance().ResolveVideo(
        sherpa_onnx::codec::Use::Display, p->options().decodePolicy,
        p->entry()->decodePolicy());
    req.ownerKey = p->id();
    const auto plan =
        sherpa_onnx::codec::MakePlan(req, sherpa_onnx::codec::CodecCatalog::Instance());
    for (const auto& step : plan.steps) {
      if (!step.provider) continue;
      providerName = step.provider->name;
      software = step.provider->tier == sherpa_onnx::codec::Tier::Software;
      break;
    }
  }

  if (software) {
    auto r = std::make_unique<DecodedSampleBufferRenderer>();
    r->SetLayer((__bridge void *)self.displayLayer);
    auto dec = OpenDecoderForProvider(providerName.empty() ? "vt.sw" : providerName);
    if (dec) {
      r->SetDecoder(std::shared_ptr<sherpa_onnx::video::DecoderBackend>(
          std::move(dec)));
    }
    if (p->entry() && p->entry()->packets()) {
      (void)r->Configure(p->entry()->packets()->track());
    }
    p->TakeVideoRenderer(std::move(r));
  } else {
    auto r = std::make_unique<SampleBufferVideoRenderer>();
    r->SetLayer((__bridge void *)self.displayLayer);
    if (p->entry() && p->entry()->packets()) {
      (void)r->Configure(p->entry()->packets()->track());
    }
    p->TakeVideoRenderer(std::move(r));
  }
  // Pace the display layer by the audio clock (no-op for silent clips).
  if (auto* audio =
          dynamic_cast<SampleBufferAudioRenderer*>(p->audioRenderer())) {
    audio->AttachVideoLayer((__bridge void *)self.displayLayer);
  }
  PreviewInput in;
  in.kind = PreviewInputKind::SurfaceAttached;
  p->Post(in, p->state().positionUs);
}

@end
