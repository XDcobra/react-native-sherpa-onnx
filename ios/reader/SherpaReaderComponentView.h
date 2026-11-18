#pragma once

#import <UIKit/UIKit.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <React/RCTViewComponentView.h>

NS_ASSUME_NONNULL_BEGIN

@class SherpaReaderInsertComponentView;

/**
 * Fabric ReaderView: a native table of reader blocks. React children are insert
 * and marker hosts (SherpaReaderInsertComponentView); they are not added as
 * subviews but moved into the rows that the `inserts` prop assigns to them, or
 * into the marker overlay of the row a marker sits in.
 */
@interface SherpaReaderComponentView : RCTViewComponentView

- (void)insertHostDidResize:(SherpaReaderInsertComponentView *)host;
- (void)insertHostDidChangeKey:(SherpaReaderInsertComponentView *)host;

@end

NS_ASSUME_NONNULL_END

#endif
