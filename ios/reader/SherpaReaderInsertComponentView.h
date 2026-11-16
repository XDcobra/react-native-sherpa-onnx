#pragma once

#import <UIKit/UIKit.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <React/RCTViewComponentView.h>

NS_ASSUME_NONNULL_BEGIN

@class SherpaReaderComponentView;

/**
 * Fabric host for one ReaderView insert. React lays it out (Yoga) at the full
 * reader width; SherpaReaderComponentView moves it into the matching list row.
 */
@interface SherpaReaderInsertComponentView : RCTViewComponentView

@property (nonatomic, copy, readonly) NSString *insertKey;
@property (nonatomic, weak, nullable) SherpaReaderComponentView *reader;

/** Height from the latest Yoga layout (valid while off screen). */
- (CGFloat)yogaHeight;

/**
 * Where the host is shown, relative to the reader's top-left (its Yoga
 * origin). Pushed into the shadow state so `measure` matches the screen.
 */
- (void)setOnScreenOrigin:(CGPoint)origin;

@end

NS_ASSUME_NONNULL_END

#endif
