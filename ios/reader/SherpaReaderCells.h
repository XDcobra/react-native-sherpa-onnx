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

/** A marker in the trailing margin of a row (`markers` prop), shown by the app's view. */
@interface SherpaReaderMarker : NSObject
@property (nonatomic, copy) NSString *markerId;
/**
 * The marker's React view (a marker host), nil while JS has not mounted it.
 * Sized by Yoga; the row only places it.
 */
@property (nonatomic, weak, nullable) UIView *host;
/** Size of `host` from the latest Yoga layout. */
@property (nonatomic, assign) CGSize hostSize;
/** Text rows: UTF-16 offset whose line the marker sits at; -1 = the first line. */
@property (nonatomic, assign) NSInteger offset;
/** Image rows: the marker's line normalized to the image (y, height); height <= 0 = the image top. */
@property (nonatomic, assign) CGFloat pageY;
@property (nonatomic, assign) CGFloat pageHeight;
@end

@class SherpaReaderTextCell;

/** Selection callbacks of text rows (the reader view). */
@protocol SherpaReaderCellDelegate <NSObject>
/** The range a selection is widened to (`selectionSnap`). */
- (NSRange)textCell:(SherpaReaderTextCell *)cell snapSelection:(NSRange)range;
- (void)textCellDidChangeSelection:(SherpaReaderTextCell *)cell;
/** Menu for a selection: app items, then the suggested system items. */
- (nullable UIMenu *)textCell:(SherpaReaderTextCell *)cell
                 menuForRange:(NSRange)range
             suggestedActions:(NSArray<UIMenuElement *> *)suggested API_AVAILABLE(ios(16.0));
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
@property (nonatomic, weak, nullable) id<SherpaReaderCellDelegate> delegate;
/** Flat block index of the row (set by the reader view). */
@property (nonatomic, assign) NSInteger blockIndex;
/** Long-press text selection (`selectable` prop). */
@property (nonatomic, assign) BOOL selectable;
/** Selected UTF-16 range of the block text (length 0: none). */
@property (nonatomic, readonly) NSRange selectedRange;
- (void)clearSelection;
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
/**
 * Margin markers of the row: moves their mounted hosts into the row's overlay
 * and places them at their lines; the text layout does not change.
 */
- (void)updateMarkers:(nullable NSArray<SherpaReaderMarker *> *)markers theme:(SherpaReaderTheme *)theme;
/** The row's placed marker hosts, top to bottom (the reader hit-tests their hit areas). */
- (NSArray<UIView *> *)placedMarkerHosts;
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
@property (nonatomic, weak, nullable) id<SherpaReaderCellDelegate> delegate;
/** Margin markers (page images have no margin: at the page's trailing edge). */
- (void)updateMarkers:(nullable NSArray<SherpaReaderMarker *> *)markers theme:(SherpaReaderTheme *)theme;
/** The row's placed marker hosts, top to bottom (the reader hit-tests their hit areas). */
- (NSArray<UIView *> *)placedMarkerHosts;
@end

@interface SherpaReaderSeparatorCell : UITableViewCell
- (void)configureWithTheme:(SherpaReaderTheme *)theme;
@end

NS_ASSUME_NONNULL_END
