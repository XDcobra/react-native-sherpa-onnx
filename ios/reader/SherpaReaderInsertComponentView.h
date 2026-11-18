#pragma once

#import <UIKit/UIKit.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <React/RCTViewComponentView.h>

NS_ASSUME_NONNULL_BEGIN

@class SherpaReaderComponentView;

/**
 * Fabric host for one ReaderView insert or margin marker. React lays it out
 * (Yoga): inserts at the full reader width, markers at their content size.
 * SherpaReaderComponentView moves it into the matching list row (inserts) or
 * into the marker overlay of the row its marker sits in (markers).
 */
@interface SherpaReaderInsertComponentView : RCTViewComponentView

@property (nonatomic, copy, readonly) NSString *insertKey;
/** Non-empty for a marker host. */
@property (nonatomic, copy, readonly) NSString *markerId;
@property (nonatomic, weak, nullable) SherpaReaderComponentView *reader;

/** Height from the latest Yoga layout (valid while off screen). */
- (CGFloat)yogaHeight;
/** Size from the latest Yoga layout. */
- (CGSize)yogaSize;

/**
 * Where the host is shown, relative to the reader's top-left (its Yoga
 * origin). Pushed into the shadow state so `measure` matches the screen.
 */
- (void)setOnScreenOrigin:(CGPoint)origin;

@end

NS_ASSUME_NONNULL_END

#endif
