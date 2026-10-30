#import <React/RCTViewManager.h>
#import "VideoPreviewView.h"

@interface VideoPreviewViewManager : RCTViewManager
@end

@implementation VideoPreviewViewManager

RCT_EXPORT_MODULE(SherpaOnnxVideoPreviewView)

- (UIView *)view {
  return [[VideoPreviewView alloc] init];
}

RCT_EXPORT_VIEW_PROPERTY(playerId, NSString)
RCT_EXPORT_VIEW_PROPERTY(resizeMode, NSString)

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

@end

@interface VideoPreviewTextureViewManager : RCTViewManager
@end

@implementation VideoPreviewTextureViewManager

RCT_EXPORT_MODULE(SherpaOnnxVideoPreviewTextureView)

- (UIView *)view {
  return [[VideoPreviewView alloc] init];
}

RCT_EXPORT_VIEW_PROPERTY(playerId, NSString)
RCT_EXPORT_VIEW_PROPERTY(resizeMode, NSString)

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

@end
