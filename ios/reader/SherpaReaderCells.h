#pragma once

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, SherpaReaderHighlightStyle) {
  SherpaReaderHighlightStyleBackground = 0,
  SherpaReaderHighlightStyleUnderline = 1,
  SherpaReaderHighlightStyleTextColor = 2,
};

/** Part of a highlight inside one block: UTF-16 range of the block text. */
@interface SherpaReaderHighlightSpan : NSObject
@property (nonatomic, assign) NSRange range;
@property (nonatomic, assign) SherpaReaderHighlightStyle style;
/** nil: the theme's accent (background at 30 % opacity). */
@property (nonatomic, strong, nullable) UIColor *color;
@end

/** Inline style inside one block: UTF-16 range of the block text, italic and / or bold. */
@interface SherpaReaderStyleSpan : NSObject
@property (nonatomic, assign) NSRange range;
@property (nonatomic, assign) BOOL italic;
@property (nonatomic, assign) BOOL bold;
@end

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
- (NSAttributedString *)attributedText:(NSString *)text
                          headingLevel:(NSInteger)level
                            highlights:(nullable NSArray<SherpaReaderHighlightSpan *> *)highlights;
/**
 * Text with inline styles and highlights. Styles pick the italic / bold face of
 * the row font; a family without that face gets a synthetic one (oblique /
 * stroke) that keeps the glyph advances, so the layout matches the real face.
 */
- (NSAttributedString *)attributedText:(NSString *)text
                          headingLevel:(NSInteger)level
                                styles:(nullable NSArray<SherpaReaderStyleSpan *> *)styles
                            highlights:(nullable NSArray<SherpaReaderHighlightSpan *> *)highlights;
@end

/** Paragraph / heading row: non-editable TextKit 1 text view (offset ↔ point). */
@interface SherpaReaderTextCell : UITableViewCell
@property (nonatomic, strong, readonly) UITextView *textView;
- (void)configureWithText:(NSString *)text
             headingLevel:(NSInteger)level
               highlights:(nullable NSArray<SherpaReaderHighlightSpan *> *)highlights
                    theme:(SherpaReaderTheme *)theme;
/** Inline styles are part of the first layout, so the measured row height includes them. */
- (void)configureWithText:(NSString *)text
             headingLevel:(NSInteger)level
                   styles:(nullable NSArray<SherpaReaderStyleSpan *> *)styles
               highlights:(nullable NSArray<SherpaReaderHighlightSpan *> *)highlights
                    theme:(SherpaReaderTheme *)theme;
/** Re-applies highlights only (same text, styles and theme; the layout does not change). */
- (void)updateHighlights:(nullable NSArray<SherpaReaderHighlightSpan *> *)highlights
                   theme:(SherpaReaderTheme *)theme;
/** UTF-16 offset of the character at `point` (cell coordinates). */
- (NSInteger)characterOffsetAtPoint:(CGPoint)point;
/** Top of the line holding `offset`, in cell coordinates. */
- (CGFloat)lineTopForCharacterOffset:(NSInteger)offset;
@end

/** A highlight over a page image: `rect` normalized to the page. */
@interface SherpaReaderPageMark : NSObject
@property (nonatomic, assign) CGRect rect;
@property (nonatomic, assign) SherpaReaderHighlightStyle style;
@property (nonatomic, strong) UIColor *color;
@end

@interface SherpaReaderImageCell : UITableViewCell
- (void)configureWithBufferId:(nullable NSString *)bufferId
                   frameIndex:(NSInteger)frameIndex
                          alt:(nullable NSString *)alt
                        theme:(SherpaReaderTheme *)theme;
/** `page`: a page image, full width without margins. */
- (void)configureWithBufferId:(nullable NSString *)bufferId
                   frameIndex:(NSInteger)frameIndex
                          alt:(nullable NSString *)alt
                        theme:(SherpaReaderTheme *)theme
                         page:(BOOL)page;
/** Highlights drawn over the page (background fill, underline, text-color frame). */
- (void)updatePageMarks:(NSArray<SherpaReaderPageMark *> *)marks;
@end

@interface SherpaReaderSeparatorCell : UITableViewCell
- (void)configureWithTheme:(SherpaReaderTheme *)theme;
@end

NS_ASSUME_NONNULL_END
