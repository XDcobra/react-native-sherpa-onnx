#import "SherpaReaderCells.h"

#import "../imagebuffer/OfflineImageBufferFrameView.h"

@implementation SherpaReaderHighlightSpan
@end

@implementation SherpaReaderStyleSpan
@end

/** A row font with italic / bold, and what has to be synthesized when the family lacks the face. */
@interface SherpaReaderStyledFont : NSObject
@property (nonatomic, strong) UIFont *font;
@property (nonatomic, assign) BOOL obliqueFallback;
@property (nonatomic, assign) BOOL strokeFallback;
@end

@implementation SherpaReaderStyledFont
@end

@implementation SherpaReaderTheme {
  NSMutableDictionary<NSNumber *, SherpaReaderStyledFont *> *_styledFonts;
}

- (UIFont *)fontForHeadingLevel:(NSInteger)level {
  if (level <= 0) return self.bodyFont;
  static const CGFloat kScale[] = {1.0, 1.6, 1.35, 1.2, 1.1, 1.05, 1.0};
  const CGFloat size = self.bodyFont.pointSize * kScale[MIN(level, (NSInteger)6)];
  UIFontDescriptor *d =
      [self.bodyFont.fontDescriptor fontDescriptorWithSymbolicTraits:UIFontDescriptorTraitBold];
  return d ? [UIFont fontWithDescriptor:d size:size] : [UIFont boldSystemFontOfSize:size];
}

- (SherpaReaderStyledFont *)styledFontForLevel:(NSInteger)level italic:(BOOL)italic bold:(BOOL)bold {
  NSNumber *key = @(level * 4 + (italic ? 1 : 0) + (bold ? 2 : 0));
  if (!_styledFonts) _styledFonts = [NSMutableDictionary new];
  SherpaReaderStyledFont *cached = _styledFonts[key];
  if (cached) return cached;
  UIFont *base = [self fontForHeadingLevel:level];
  UIFontDescriptorSymbolicTraits want = base.fontDescriptor.symbolicTraits;
  if (italic) want |= UIFontDescriptorTraitItalic;
  if (bold) want |= UIFontDescriptorTraitBold;
  UIFont *font = base;
  UIFontDescriptor *d = [base.fontDescriptor fontDescriptorWithSymbolicTraits:want];
  if (d) {
    UIFont *f = [UIFont fontWithDescriptor:d size:base.pointSize];
    if (f) font = f;
  }
  // Custom families: the descriptor may fall back to another family or face. Keep
  // the row's family and fake what it does not have.
  if (![font.familyName isEqualToString:base.familyName]) font = base;
  const UIFontDescriptorSymbolicTraits got = font.fontDescriptor.symbolicTraits;
  SherpaReaderStyledFont *out = [SherpaReaderStyledFont new];
  out.font = font;
  out.obliqueFallback = italic && !(got & UIFontDescriptorTraitItalic);
  out.strokeFallback = bold && !(got & UIFontDescriptorTraitBold);
  _styledFonts[key] = out;
  return out;
}

- (void)applyStyles:(NSArray<SherpaReaderStyleSpan *> *)styles
              level:(NSInteger)level
                 to:(NSMutableAttributedString *)s {
  const NSUInteger len = s.length;
  for (SherpaReaderStyleSpan *st in styles) {
    if (st.range.location >= len || (!st.italic && !st.bold)) continue;
    const NSRange r = NSMakeRange(st.range.location, MIN(st.range.length, len - st.range.location));
    if (r.length == 0) continue;
    SherpaReaderStyledFont *f = [self styledFontForLevel:level italic:st.italic bold:st.bold];
    [s addAttribute:NSFontAttributeName value:f.font range:r];
    if (f.obliqueFallback) [s addAttribute:NSObliquenessAttributeName value:@0.2 range:r];
    // Negative stroke width = fill and stroke: a heavier glyph with the same advance.
    if (f.strokeFallback) [s addAttribute:NSStrokeWidthAttributeName value:@(-3.0) range:r];
  }
}

- (void)applyHighlights:(NSArray<SherpaReaderHighlightSpan *> *)highlights
                     to:(NSMutableAttributedString *)s {
  const NSUInteger len = s.length;
  for (SherpaReaderHighlightSpan *h in highlights) {
    if (h.range.location >= len) continue;
    const NSRange r = NSMakeRange(h.range.location, MIN(h.range.length, len - h.range.location));
    if (r.length == 0) continue;
    switch (h.style) {
      case SherpaReaderHighlightStyleBackground:
        [s addAttribute:NSBackgroundColorAttributeName
                  value:h.color ?: [self.accentColor colorWithAlphaComponent:0.3]
                  range:r];
        break;
      case SherpaReaderHighlightStyleUnderline:
        [s addAttribute:NSUnderlineStyleAttributeName value:@(NSUnderlineStyleThick) range:r];
        [s addAttribute:NSUnderlineColorAttributeName value:h.color ?: self.accentColor range:r];
        break;
      case SherpaReaderHighlightStyleTextColor:
        [s addAttribute:NSForegroundColorAttributeName value:h.color ?: self.accentColor range:r];
        break;
    }
  }
}

- (NSAttributedString *)attributedText:(NSString *)text
                          headingLevel:(NSInteger)level
                            highlights:(NSArray<SherpaReaderHighlightSpan *> *)highlights {
  return [self attributedText:text headingLevel:level styles:nil highlights:highlights];
}

- (NSAttributedString *)attributedText:(NSString *)text
                          headingLevel:(NSInteger)level
                                styles:(NSArray<SherpaReaderStyleSpan *> *)styles
                            highlights:(NSArray<SherpaReaderHighlightSpan *> *)highlights {
  NSMutableParagraphStyle *p = [NSMutableParagraphStyle new];
  p.lineHeightMultiple = self.lineHeightMultiple;
  p.alignment = level > 0 ? NSTextAlignmentNatural : self.alignment;
  p.hyphenationFactor = (self.hyphenation && level == 0) ? 1.0f : 0.0f;
  NSMutableDictionary *attrs = [@{
    NSFontAttributeName : [self fontForHeadingLevel:level],
    NSForegroundColorAttributeName : self.textColor,
    NSParagraphStyleAttributeName : p,
  } mutableCopy];
  if (self.language.length > 0) {
    attrs[NSLanguageIdentifierAttributeName] = self.language;
  }
  if (highlights.count == 0 && styles.count == 0) {
    return [[NSAttributedString alloc] initWithString:text attributes:attrs];
  }
  NSMutableAttributedString *s = [[NSMutableAttributedString alloc] initWithString:text attributes:attrs];
  if (styles.count > 0) [self applyStyles:styles level:level to:s];
  [self applyHighlights:highlights to:s];
  return s;
}

@end

static void Pin(UIView *view, UIView *host, UIEdgeInsets insets) {
  view.translatesAutoresizingMaskIntoConstraints = NO;
  [NSLayoutConstraint activateConstraints:@[
    [view.leadingAnchor constraintEqualToAnchor:host.leadingAnchor constant:insets.left],
    [view.trailingAnchor constraintEqualToAnchor:host.trailingAnchor constant:-insets.right],
    [view.topAnchor constraintEqualToAnchor:host.topAnchor constant:insets.top],
    [view.bottomAnchor constraintEqualToAnchor:host.bottomAnchor constant:-insets.bottom],
  ]];
}

@implementation SherpaReaderTextCell {
  NSArray<NSLayoutConstraint *> *_pins;
  NSString *_text;
  NSInteger _level;
  NSArray<SherpaReaderStyleSpan *> *_styles;
}

- (instancetype)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)reuseIdentifier {
  if (self = [super initWithStyle:style reuseIdentifier:reuseIdentifier]) {
    self.backgroundColor = UIColor.clearColor;
    self.selectionStyle = UITableViewCellSelectionStyleNone;
    if (@available(iOS 16.0, *)) {
      _textView = [UITextView textViewUsingTextLayoutManager:NO];
    } else {
      _textView = [[UITextView alloc] initWithFrame:CGRectZero];
    }
    _textView.editable = NO;
    _textView.selectable = NO;
    _textView.scrollEnabled = NO;
    _textView.userInteractionEnabled = NO;
    _textView.backgroundColor = UIColor.clearColor;
    _textView.textContainerInset = UIEdgeInsetsZero;
    _textView.textContainer.lineFragmentPadding = 0;
    _textView.isAccessibilityElement = NO;
    _textView.accessibilityElementsHidden = YES;
    _textView.showsVerticalScrollIndicator = NO;
    _textView.showsHorizontalScrollIndicator = NO;
    self.isAccessibilityElement = YES;
    [self.contentView addSubview:_textView];
  }
  return self;
}

- (void)configureWithText:(NSString *)text
             headingLevel:(NSInteger)level
               highlights:(NSArray<SherpaReaderHighlightSpan *> *)highlights
                    theme:(SherpaReaderTheme *)theme {
  [self configureWithText:text headingLevel:level styles:nil highlights:highlights theme:theme];
}

- (void)configureWithText:(NSString *)text
             headingLevel:(NSInteger)level
                   styles:(NSArray<SherpaReaderStyleSpan *> *)styles
               highlights:(NSArray<SherpaReaderHighlightSpan *> *)highlights
                    theme:(SherpaReaderTheme *)theme {
  _text = [text copy];
  _level = level;
  _styles = [styles copy];
  const CGFloat top = level > 0 ? theme.paragraphSpacing : 0;
  UIEdgeInsets insets = UIEdgeInsetsMake(top, theme.marginHorizontal, theme.paragraphSpacing,
                                         theme.marginHorizontal);
  if (_pins) [NSLayoutConstraint deactivateConstraints:_pins];
  _textView.translatesAutoresizingMaskIntoConstraints = NO;
  _pins = @[
    [_textView.leadingAnchor constraintEqualToAnchor:self.contentView.leadingAnchor constant:insets.left],
    [_textView.trailingAnchor constraintEqualToAnchor:self.contentView.trailingAnchor constant:-insets.right],
    [_textView.topAnchor constraintEqualToAnchor:self.contentView.topAnchor constant:insets.top],
    [_textView.bottomAnchor constraintEqualToAnchor:self.contentView.bottomAnchor constant:-insets.bottom],
  ];
  [NSLayoutConstraint activateConstraints:_pins];
  _textView.attributedText = [theme attributedText:text
                                       headingLevel:level
                                             styles:_styles
                                         highlights:highlights];
  self.accessibilityLabel = text;
  self.accessibilityTraits = level > 0 ? UIAccessibilityTraitHeader : UIAccessibilityTraitStaticText;
}

- (void)updateHighlights:(NSArray<SherpaReaderHighlightSpan *> *)highlights
                   theme:(SherpaReaderTheme *)theme {
  if (_text == nil) return;
  // Same string, styles and fonts: only color / underline attributes change, so
  // the text layout (and the row height) stays the same.
  _textView.attributedText = [theme attributedText:_text
                                      headingLevel:_level
                                            styles:_styles
                                        highlights:highlights];
}

- (NSInteger)characterOffsetAtPoint:(CGPoint)point {
  CGPoint p = [self.contentView convertPoint:point toView:_textView];
  NSLayoutManager *lm = _textView.layoutManager;
  NSTextContainer *tc = _textView.textContainer;
  if (!lm || !tc) return 0;
  p.y = MAX(0, MIN(p.y, _textView.bounds.size.height - 1));
  return (NSInteger)[lm characterIndexForPoint:p inTextContainer:tc
                fractionOfDistanceBetweenInsertionPoints:nil];
}

- (CGFloat)lineTopForCharacterOffset:(NSInteger)offset {
  NSLayoutManager *lm = _textView.layoutManager;
  NSTextContainer *tc = _textView.textContainer;
  if (!lm || !tc || _textView.textStorage.length == 0) return 0;
  const NSUInteger idx = MIN((NSUInteger)MAX(0, offset), _textView.textStorage.length - 1);
  const NSUInteger glyph = [lm glyphIndexForCharacterAtIndex:idx];
  CGRect line = [lm lineFragmentRectForGlyphAtIndex:glyph effectiveRange:nil];
  return [_textView convertPoint:line.origin toView:self.contentView].y;
}

@end

@implementation SherpaReaderPageMark
@end

/** Draws page marks over the page image it covers. */
@interface SherpaReaderPageOverlay : UIView
@property (nonatomic, copy) NSArray<SherpaReaderPageMark *> *marks;
@end

@implementation SherpaReaderPageOverlay

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    self.opaque = NO;
    self.backgroundColor = UIColor.clearColor;
    self.userInteractionEnabled = NO;
    self.contentMode = UIViewContentModeRedraw;
  }
  return self;
}

- (void)setMarks:(NSArray<SherpaReaderPageMark *> *)marks {
  _marks = [marks copy];
  [self setNeedsDisplay];
}

- (void)drawRect:(CGRect)rect {
  const CGSize size = self.bounds.size;
  for (SherpaReaderPageMark *m in _marks) {
    const CGRect r = CGRectMake(m.rect.origin.x * size.width, m.rect.origin.y * size.height,
                                m.rect.size.width * size.width, m.rect.size.height * size.height);
    switch (m.style) {
      case SherpaReaderHighlightStyleUnderline: {
        UIBezierPath *line = [UIBezierPath bezierPath];
        [line moveToPoint:CGPointMake(CGRectGetMinX(r), CGRectGetMaxY(r))];
        [line addLineToPoint:CGPointMake(CGRectGetMaxX(r), CGRectGetMaxY(r))];
        line.lineWidth = 2;
        [m.color setStroke];
        [line stroke];
        break;
      }
      case SherpaReaderHighlightStyleTextColor: {
        UIBezierPath *frame = [UIBezierPath bezierPathWithRect:r];
        frame.lineWidth = 2;
        [m.color setStroke];
        [frame stroke];
        break;
      }
      default:
        [m.color setFill];
        UIRectFillUsingBlendMode(r, kCGBlendModeNormal);
        break;
    }
  }
}

@end

@implementation SherpaReaderImageCell {
  OfflineImageBufferFrameView *_frameView;
  SherpaReaderPageOverlay *_overlay;
}

- (instancetype)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)reuseIdentifier {
  if (self = [super initWithStyle:style reuseIdentifier:reuseIdentifier]) {
    self.backgroundColor = UIColor.clearColor;
    self.selectionStyle = UITableViewCellSelectionStyleNone;
    _frameView = [[OfflineImageBufferFrameView alloc] initWithFrame:CGRectZero];
    _frameView.resizeMode = @"contain";
    _frameView.clipsToBounds = YES;
    [self.contentView addSubview:_frameView];
  }
  return self;
}

- (void)configureWithBufferId:(NSString *)bufferId
                   frameIndex:(NSInteger)frameIndex
                          alt:(NSString *)alt
                        theme:(SherpaReaderTheme *)theme {
  [self configureWithBufferId:bufferId frameIndex:frameIndex alt:alt theme:theme page:NO];
}

- (void)configureWithBufferId:(NSString *)bufferId
                   frameIndex:(NSInteger)frameIndex
                          alt:(NSString *)alt
                        theme:(SherpaReaderTheme *)theme
                         page:(BOOL)page {
  [_frameView removeFromSuperview];
  [self.contentView addSubview:_frameView];
  Pin(_frameView, self.contentView,
      page ? UIEdgeInsetsZero
           : UIEdgeInsetsMake(theme.paragraphSpacing / 2, theme.marginHorizontal,
                              theme.paragraphSpacing, theme.marginHorizontal));
  _frameView.maxSide = 2048;
  _frameView.bufferId = bufferId;
  _frameView.frameIndex = frameIndex;
  if (_overlay == nil) {
    _overlay = [[SherpaReaderPageOverlay alloc] initWithFrame:CGRectZero];
  }
  [_overlay removeFromSuperview];
  [self.contentView addSubview:_overlay];
  Pin(_overlay, _frameView, UIEdgeInsetsZero);
  _overlay.marks = @[];
  // Images without alt text are decorative: hidden from VoiceOver.
  self.isAccessibilityElement = alt.length > 0;
  self.accessibilityLabel = alt;
  self.accessibilityTraits = UIAccessibilityTraitImage;
}

- (void)updatePageMarks:(NSArray<SherpaReaderPageMark *> *)marks {
  _overlay.marks = marks ?: @[];
}

@end

@implementation SherpaReaderSeparatorCell {
  UIView *_line;
}

- (instancetype)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)reuseIdentifier {
  if (self = [super initWithStyle:style reuseIdentifier:reuseIdentifier]) {
    self.backgroundColor = UIColor.clearColor;
    self.selectionStyle = UITableViewCellSelectionStyleNone;
    self.isAccessibilityElement = NO;
    _line = [UIView new];
    [self.contentView addSubview:_line];
  }
  return self;
}

- (void)configureWithTheme:(SherpaReaderTheme *)theme {
  _line.backgroundColor = [theme.textColor colorWithAlphaComponent:0.35];
  _line.translatesAutoresizingMaskIntoConstraints = NO;
  [NSLayoutConstraint deactivateConstraints:_line.constraints];
  [NSLayoutConstraint activateConstraints:@[
    [_line.centerXAnchor constraintEqualToAnchor:self.contentView.centerXAnchor],
    [_line.centerYAnchor constraintEqualToAnchor:self.contentView.centerYAnchor],
    [_line.widthAnchor constraintEqualToConstant:80],
    [_line.heightAnchor constraintEqualToConstant:1],
  ]];
}

@end
