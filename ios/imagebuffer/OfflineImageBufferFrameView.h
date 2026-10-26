#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface OfflineImageBufferFrameView : UIImageView

@property (nonatomic, copy, nullable) NSString *bufferId;
@property (nonatomic, assign) NSInteger frameIndex;
@property (nonatomic, assign) NSInteger maxSide;
@property (nonatomic, copy, nullable) NSString *resizeMode;

- (void)reloadFrame;

@end

NS_ASSUME_NONNULL_END
