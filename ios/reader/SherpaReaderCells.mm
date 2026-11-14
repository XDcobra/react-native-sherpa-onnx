#import "SherpaReaderCells.h"

#import "../imagebuffer/OfflineImageBufferFrameView.h"

@implementation SherpaReaderHighlightSpan
@end

@implementation SherpaReaderTheme

- (UIFont *)fontForHeadingLevel:(NSInteger)level {
  if (level <= 0) return self.bodyFont;
  static const CGFloat kScale[] = {1.0, 1.6, 1.35, 1.2, 1.1, 1.05, 1.0};
  const CGFloat size = self.bodyFont.pointSize * kScale[MIN(level, (NSInteger)6)];
  UIFontDescriptor *d =
      [self.bodyFont.fontDescriptor fontDescriptorWithSymbolicTraits:UIFontDescriptorTraitBold];
  return d ? [UIFont fontWithDescriptor:d size:size] : [UIFont boldSystemFontOfSize:size];
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
  if (highlights.count == 0) {
    return [[NSAttributedString alloc] initWithString:text attributes:attrs];
  }
  NSMutableAttributedString *s = [[NSMutableAttributedString alloc] initWithString:text attributes:attrs];
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
  _text = [text copy];
  _level = level;
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
  _textView.attributedText = [theme attributedText:text headingLevel:level highlights:highlights];
  self.accessibilityLabel = text;
  self.accessibilityTraits = level > 0 ? UIAccessibilityTraitHeader : UIAccessibilityTraitStaticText;
}

- (void)updateHighlights:(NSArray<SherpaReaderHighlightSpan *> *)highlights
                   theme:(SherpaReaderTheme *)theme {
  if (_text == nil) return;
  // Same string and fonts: only color / underline attributes change, so the
  // text layout (and the row height) stays the same.
  _textView.attributedText = [theme attributedText:_text headingLevel:_level highlights:highlights];
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

@implementation SherpaReaderImageCell {
  OfflineImageBufferFrameView *_frameView;
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
  [_frameView removeFromSuperview];
  [self.contentView addSubview:_frameView];
  Pin(_frameView, self.contentView,
      UIEdgeInsetsMake(theme.paragraphSpacing / 2, theme.marginHorizontal, theme.paragraphSpacing,
                       theme.marginHorizontal));
  _frameView.maxSide = 2048;
  _frameView.bufferId = bufferId;
  _frameView.frameIndex = frameIndex;
  // Images without alt text are decorative: hidden from VoiceOver.
  self.isAccessibilityElement = alt.length > 0;
  self.accessibilityLabel = alt;
  self.accessibilityTraits = UIAccessibilityTraitImage;
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
