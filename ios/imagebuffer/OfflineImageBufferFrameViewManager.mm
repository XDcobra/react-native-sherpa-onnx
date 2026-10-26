#import <React/RCTViewManager.h>

#import "OfflineImageBufferFrameView.h"

@interface OfflineImageBufferFrameViewManager : RCTViewManager
@end

@implementation OfflineImageBufferFrameViewManager

RCT_EXPORT_MODULE(OfflineImageBufferFrameView)

- (UIView *)view {
  return [[OfflineImageBufferFrameView alloc] init];
}

RCT_EXPORT_VIEW_PROPERTY(bufferId, NSString)
RCT_EXPORT_VIEW_PROPERTY(frameIndex, NSInteger)
RCT_EXPORT_VIEW_PROPERTY(maxSide, NSInteger)
RCT_EXPORT_VIEW_PROPERTY(resizeMode, NSString)

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

@end
