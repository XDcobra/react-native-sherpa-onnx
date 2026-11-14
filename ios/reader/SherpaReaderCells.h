#pragma once

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/** Resolved typography and colors of a ReaderView (from the `theme` props). */
@interface SherpaReaderTheme : NSObject
@property (nonatomic, strong) UIFont *bodyFont;
@property (nonatomic, assign) CGFloat lineHeightMultiple;
@property (nonatomic, assign) CGFloat paragraphSpacing;  // points
@property (nonatomic, assign) CGFloat marginHorizontal;
@property (nonatomic, assign) CGFloat marginVertical;
@property (nonatomic, assign) NSTextAlignment alignment;
@property (nonatomic, assign) BOOL hyphenation;
@property (nonatomic, strong) UIColor *textColor;
@property (nonatomic, strong) UIColor *accentColor;
@property (nonatomic, copy, nullable) NSString *language;

- (UIFont *)fontForHeadingLevel:(NSInteger)level;
- (NSAttributedString *)attributedText:(NSString *)text headingLevel:(NSInteger)level;
@end

/** Paragraph / heading row: non-editable TextKit 1 text view (offset ↔ point). */
@interface SherpaReaderTextCell : UITableViewCell
@property (nonatomic, strong, readonly) UITextView *textView;
- (void)configureWithText:(NSString *)text
             headingLevel:(NSInteger)level
                    theme:(SherpaReaderTheme *)theme;
/** UTF-16 offset of the character at `point` (cell coordinates). */
- (NSInteger)characterOffsetAtPoint:(CGPoint)point;
/** Top of the line holding `offset`, in cell coordinates. */
- (CGFloat)lineTopForCharacterOffset:(NSInteger)offset;
@end

@interface SherpaReaderImageCell : UITableViewCell
- (void)configureWithBufferId:(nullable NSString *)bufferId
                   frameIndex:(NSInteger)frameIndex
                          alt:(nullable NSString *)alt
                        theme:(SherpaReaderTheme *)theme;
@end

@interface SherpaReaderSeparatorCell : UITableViewCell
- (void)configureWithTheme:(SherpaReaderTheme *)theme;
@end

NS_ASSUME_NONNULL_END
