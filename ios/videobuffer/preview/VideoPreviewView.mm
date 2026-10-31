#import "VideoPreviewView.h"

#import <AVFoundation/AVFoundation.h>

#include "SampleBufferVideoRenderer.h"
#include "VideoRegistry.h"
#include "preview/PreviewPlayer.h"

using sherpa_onnx::video::preview::PreviewInput;
using sherpa_onnx::video::preview::PreviewInputKind;
using sherpa_onnx::video::preview::PreviewRegistry;
using sherpa_onnx::video::preview::SampleBufferVideoRenderer;

@implementation VideoPreviewView

+ (Class)layerClass {
  return [AVSampleBufferDisplayLayer class];
}

- (AVSampleBufferDisplayLayer *)displayLayer {
  return (AVSampleBufferDisplayLayer *)self.layer;
}

- (void)setPlayerId:(NSString *)playerId {
  if ([_playerId isEqualToString:playerId]) return;
  if (_playerId.length > 0) {
    auto old = PreviewRegistry::Instance().Get([_playerId UTF8String]);
    if (old) {
      PreviewInput in;
      in.kind = PreviewInputKind::SurfaceDetached;
      old->Post(in, old->state().positionUs);
      old->SetVideoRenderer(nullptr);
    }
  }
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
  [self attachIfPossible];
}

- (void)attachIfPossible {
  if (self.playerId.length == 0) return;
  auto p = PreviewRegistry::Instance().Get([self.playerId UTF8String]);
  if (!p) return;
  auto r = std::make_unique<SampleBufferVideoRenderer>();
  r->SetLayer((__bridge void *)self.displayLayer);
  if (p->entry() && p->entry()->packets()) {
    (void)r->Configure(p->entry()->packets()->track());
  }
  p->TakeVideoRenderer(std::move(r));
  PreviewInput in;
  in.kind = PreviewInputKind::SurfaceAttached;
  p->Post(in, p->state().positionUs);
}

@end
