#import "SherpaReaderCells.h"

#import "../imagebuffer/OfflineImageBufferFrameView.h"

@implementation SherpaReaderHighlightSpan
@end

@implementation SherpaReaderStyleSpan
@end

@implementation SherpaReaderMarker
@end

/**
 * Margin markers of one row: holds the marker hosts (the app's React views)
 * and places each in the trailing margin, vertically centered on the line the
 * row gives. Markers on the same line go below one another. Only touches
 * inside a host's frame hit it here; its larger hit area (hit slop) can reach
 * into the neighbouring rows, so the reader view hit-tests that. Touches
 * outside the hosts fall through to the row.
 */
@interface SherpaReaderMarkerOverlay : UIView
/** Moves the mounted hosts of `markers` in (and hosts of other markers out). */
- (void)attachMarkers:(NSArray<SherpaReaderMarker *> *)markers;
/** Places the attached hosts; `centers` parallel to `markers`. */
- (void)placeMarkers:(NSArray<SherpaReaderMarker *> *)markers
             centers:(NSArray<NSNumber *> *)centers
       trailingInset:(CGFloat)inset;
/** Attached hosts, top to bottom (VoiceOver order). */
- (NSArray<UIView *> *)placedHosts;
/** Hands every host back (cell reuse). */
- (void)detachAll;
@end

@implementation SherpaReaderMarkerOverlay

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    self.opaque = NO;
    self.backgroundColor = UIColor.clearColor;
    self.isAccessibilityElement = NO;
  }
  return self;
}

- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
  if (self.hidden || !self.userInteractionEnabled) return nil;
  for (UIView *host in self.subviews.reverseObjectEnumerator) {
    // The frame, not the hit slop: SherpaReaderComponentView decides about the
    // rest of the hit area (it also sees the neighbouring rows).
    if (host.hidden || !CGRectContainsPoint(host.frame, point)) continue;
    UIView *hit = [host hitTest:[host convertPoint:point fromView:self] withEvent:event];
    if (hit) return hit;
  }
  return nil;
}

- (void)attachMarkers:(NSArray<SherpaReaderMarker *> *)markers {
  NSHashTable<UIView *> *wanted = [NSHashTable weakObjectsHashTable];
  for (SherpaReaderMarker *m in markers) {
    UIView *host = m.host;
    if (!host) continue;
    [wanted addObject:host];
    if (host.superview != self) {
      // From another (recycled or off-screen) row: the host moves, React keeps it.
      [host removeFromSuperview];
      [self addSubview:host];
    }
  }
  for (UIView *sub in [self.subviews copy]) {
    if (![wanted containsObject:sub]) [sub removeFromSuperview];
  }
}

- (void)detachAll {
  for (UIView *sub in [self.subviews copy]) [sub removeFromSuperview];
}

- (void)placeMarkers:(NSArray<SherpaReaderMarker *> *)markers
             centers:(NSArray<NSNumber *> *)centers
       trailingInset:(CGFloat)inset {
  NSArray<UIView *> *before = self.placedHosts;
  [self placeMarkersOnly:markers centers:centers trailingInset:inset];
  // Screen readers cache a row's elements: tell them when the marker views
  // (or their order) changed.
  if (![before isEqualToArray:self.placedHosts]) {
    UIAccessibilityPostNotification(UIAccessibilityLayoutChangedNotification, nil);
  }
}

- (void)placeMarkersOnly:(NSArray<SherpaReaderMarker *> *)markers
                 centers:(NSArray<NSNumber *> *)centers
           trailingInset:(CGFloat)inset {
  const CGFloat width = self.bounds.size.width;
  // Top to bottom; a marker on the line of the one before goes below it.
  NSMutableArray<NSNumber *> *order = [NSMutableArray arrayWithCapacity:markers.count];
  for (NSUInteger i = 0; i < markers.count; ++i) [order addObject:@(i)];
  [order sortWithOptions:NSSortStable
         usingComparator:^NSComparisonResult(NSNumber *a, NSNumber *b) {
           return [centers[a.unsignedIntegerValue] compare:centers[b.unsignedIntegerValue]];
         }];
  CGFloat lastBottom = -CGFLOAT_MAX;
  for (NSNumber *n in order) {
    SherpaReaderMarker *m = markers[n.unsignedIntegerValue];
    UIView *host = m.host;
    if (!host || host.superview != self) continue;
    const CGSize size = m.hostSize;
    if (size.width <= 0 || size.height <= 0) continue;  // not laid out by Yoga yet
    const CGFloat cy = MAX(centers[n.unsignedIntegerValue].doubleValue, lastBottom + 2 + size.height / 2);
    // Centered in the margin; a view wider than the margin stays inside the
    // row (it then overlaps the text).
    CGFloat x = inset > 0 ? width - inset / 2 - size.width / 2 : width - size.width;
    x = MAX(0, MIN(x, width - size.width));
    const CGRect f = CGRectMake(round(x), round(cy - size.height / 2), size.width, size.height);
    if (!CGRectEqualToRect(host.frame, f)) host.frame = f;
    lastBottom = CGRectGetMaxY(f);
  }
}

- (NSArray<UIView *> *)placedHosts {
  if (self.hidden) return @[];
  NSMutableArray<UIView *> *placed = [NSMutableArray array];
  for (UIView *v in self.subviews) {
    if (v.frame.size.width > 0 && v.frame.size.height > 0) [placed addObject:v];
  }
  [placed sortUsingComparator:^NSComparisonResult(UIView *a, UIView *b) {
    return [@(a.frame.origin.y) compare:@(b.frame.origin.y)];
  }];
  return placed;
}

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

@interface SherpaReaderTextCell () <UITextViewDelegate>
@end

@implementation SherpaReaderTextCell {
  NSArray<NSLayoutConstraint *> *_pins;
  NSString *_text;
  NSInteger _level;
  NSArray<SherpaReaderStyleSpan *> *_styles;
  SherpaReaderMarkerOverlay *_overlay;
  NSArray<SherpaReaderMarker *> *_markers;
  CGFloat _markerInset;
  BOOL _snapping;
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
    _textView.delegate = self;
    [self.contentView addSubview:_textView];
    _overlay = [[SherpaReaderMarkerOverlay alloc] initWithFrame:CGRectZero];
    _overlay.hidden = YES;
    [self.contentView addSubview:_overlay];
  }
  return self;
}

- (void)prepareForReuse {
  [super prepareForReuse];
  [self clearSelection];
  _markers = nil;
  [_overlay detachAll];
  _overlay.hidden = YES;
}

#pragma mark Selection

- (void)setSelectable:(BOOL)selectable {
  _selectable = selectable;
  _textView.selectable = selectable;
  _textView.userInteractionEnabled = selectable;
  if (!selectable) [self clearSelection];
}

- (NSRange)selectedRange {
  const NSRange r = _textView.selectedRange;
  return r.location == NSNotFound ? NSMakeRange(0, 0) : r;
}

- (void)clearSelection {
  if (_textView.selectedRange.length > 0) _textView.selectedRange = NSMakeRange(0, 0);
  if (_textView.isFirstResponder) [_textView resignFirstResponder];
}

- (void)textViewDidChangeSelection:(UITextView *)textView {
  if (_snapping) return;
  const NSRange r = self.selectedRange;
  if (r.length > 0 && self.delegate) {
    const NSRange snapped = [self.delegate textCell:self snapSelection:r];
    if (!NSEqualRanges(snapped, r) && NSMaxRange(snapped) <= textView.textStorage.length) {
      _snapping = YES;
      textView.selectedRange = snapped;
      _snapping = NO;
    }
  }
  [self.delegate textCellDidChangeSelection:self];
}

- (UIMenu *)textView:(UITextView *)textView
    editMenuForTextInRange:(NSRange)range
          suggestedActions:(NSArray<UIMenuElement *> *)suggestedActions API_AVAILABLE(ios(16.0)) {
  return [self.delegate textCell:self menuForRange:range suggestedActions:suggestedActions];
}

#pragma mark Markers

- (void)updateMarkers:(NSArray<SherpaReaderMarker *> *)markers theme:(SherpaReaderTheme *)theme {
  _markers = markers.count > 0 ? [markers copy] : nil;
  _markerInset = theme.marginHorizontal;
  [_overlay attachMarkers:_markers ?: @[]];
  [self setNeedsLayout];
  if (_markers == nil) [self layoutMarkers];
}

- (void)layoutSubviews {
  [super layoutSubviews];
  [self layoutMarkers];
}

/** Vertical center of the glyphs on the line of `offset` (-1: the first line), in content view coordinates. */
- (CGFloat)lineCenterForCharacterOffset:(NSInteger)offset {
  NSLayoutManager *lm = _textView.layoutManager;
  NSTextContainer *tc = _textView.textContainer;
  const NSUInteger len = _textView.textStorage.length;
  if (!lm || !tc || len == 0) {
    return _textView.frame.origin.y + (_textView.font.lineHeight ?: 20) / 2;
  }
  const NSUInteger idx = MIN((NSUInteger)MAX(0, offset), len - 1);
  const NSUInteger glyph = [lm glyphIndexForCharacterAtIndex:idx];
  const CGRect line = [lm lineFragmentRectForGlyphAtIndex:glyph effectiveRange:nil];
  // Baseline of the line, then the middle of the font's ascender / descender box
  // (line height multiples add space above the glyphs).
  const CGFloat baseline = line.origin.y + [lm locationForGlyphAtIndex:glyph].y;
  UIFont *font = [_textView.textStorage attribute:NSFontAttributeName atIndex:idx effectiveRange:nil] ?: _textView.font;
  const CGFloat center = baseline - (font.ascender + font.descender) / 2;
  return [_textView convertPoint:CGPointMake(0, center) toView:self.contentView].y;
}

- (void)layoutMarkers {
  if (_markers.count == 0) {
    _overlay.hidden = YES;
    return;
  }
  _overlay.frame = self.contentView.bounds;
  _overlay.hidden = NO;
  [self.contentView bringSubviewToFront:_overlay];
  NSMutableArray<NSNumber *> *centers = [NSMutableArray arrayWithCapacity:_markers.count];
  for (SherpaReaderMarker *m in _markers) {
    [centers addObject:@([self lineCenterForCharacterOffset:m.offset])];
  }
  [_overlay placeMarkers:_markers centers:centers trailingInset:_markerInset];
}

- (NSArray<UIView *> *)placedMarkerHosts {
  return _overlay.placedHosts;
}

// VoiceOver: built when asked, from the hosts' current places (they move in
// and get their size after this row was laid out). The text, then the marker
// views top to bottom (each one element, from JS).
- (BOOL)isAccessibilityElement {
  return _overlay.placedHosts.count == 0;
}

- (NSArray *)accessibilityElements {
  NSArray<UIView *> *hosts = _overlay.placedHosts;
  if (hosts.count == 0) return nil;
  UIAccessibilityElement *text = [[UIAccessibilityElement alloc] initWithAccessibilityContainer:self];
  text.accessibilityLabel = _text;
  text.accessibilityTraits = _level > 0 ? UIAccessibilityTraitHeader : UIAccessibilityTraitStaticText;
  text.accessibilityFrameInContainerSpace = [self.contentView convertRect:_textView.frame toView:self];
  return [@[ text ] arrayByAddingObjectsFromArray:hosts];
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
  // the text layout (and the row height) stays the same. A selection survives.
  const NSRange selection = self.selectedRange;
  _snapping = YES;
  _textView.attributedText = [theme attributedText:_text
                                      headingLevel:_level
                                            styles:_styles
                                        highlights:highlights];
  if (selection.length > 0 && NSMaxRange(selection) <= _textView.textStorage.length) {
    _textView.selectedRange = selection;
  }
  _snapping = NO;
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
  SherpaReaderMarkerOverlay *_markerOverlay;
  NSArray<SherpaReaderMarker *> *_markers;
  CGFloat _markerInset;
  // The alt text, kept apart: reading self.accessibilityLabel without one makes
  // UIKit build a label from the cell, which asks isAccessibilityElement again.
  NSString *_alt;
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
  _markerInset = page ? 0 : theme.marginHorizontal;
  // Images without alt text are decorative: hidden from VoiceOver.
  _alt = alt.length > 0 ? [alt copy] : nil;
  self.accessibilityLabel = _alt;
  self.accessibilityTraits = UIAccessibilityTraitImage;
}

- (void)updatePageMarks:(NSArray<SherpaReaderPageMark *> *)marks {
  _overlay.marks = marks ?: @[];
}

- (void)prepareForReuse {
  [super prepareForReuse];
  _markers = nil;
  [_markerOverlay detachAll];
  _markerOverlay.hidden = YES;
}

- (void)updateMarkers:(NSArray<SherpaReaderMarker *> *)markers theme:(SherpaReaderTheme *)theme {
  _markers = markers.count > 0 ? [markers copy] : nil;
  if (_markers != nil && _markerOverlay == nil) {
    _markerOverlay = [[SherpaReaderMarkerOverlay alloc] initWithFrame:CGRectZero];
    [self.contentView addSubview:_markerOverlay];
  }
  [_markerOverlay attachMarkers:_markers ?: @[]];
  [self setNeedsLayout];
  if (_markers == nil) [self layoutMarkers];
}

- (void)layoutSubviews {
  [super layoutSubviews];
  [self layoutMarkers];
}

- (void)layoutMarkers {
  if (_markers.count == 0) {
    _markerOverlay.hidden = YES;
    return;
  }
  _markerOverlay.frame = self.contentView.bounds;
  _markerOverlay.hidden = NO;
  [self.contentView bringSubviewToFront:_markerOverlay];
  const CGRect image = _frameView.frame;
  NSMutableArray<NSNumber *> *centers = [NSMutableArray arrayWithCapacity:_markers.count];
  for (SherpaReaderMarker *m in _markers) {
    const CGFloat y = m.pageHeight > 0 ? image.origin.y + (m.pageY + m.pageHeight / 2) * image.size.height
                                       : image.origin.y + m.hostSize.height / 2 + 4;
    [centers addObject:@(y)];
  }
  [_markerOverlay placeMarkers:_markers centers:centers trailingInset:_markerInset];
}

- (NSArray<UIView *> *)placedMarkerHosts {
  return _markerOverlay ? _markerOverlay.placedHosts : @[];
}

// VoiceOver (built when asked, like text rows): the image when it has alt
// text, then the marker views top to bottom. Without alt text the image is
// decorative.
- (BOOL)isAccessibilityElement {
  return _alt.length > 0 && (_markerOverlay == nil || _markerOverlay.placedHosts.count == 0);
}

- (NSArray *)accessibilityElements {
  NSArray<UIView *> *hosts = _markerOverlay.placedHosts;
  if (hosts.count == 0) return nil;
  NSMutableArray *elements = [NSMutableArray array];
  if (_alt.length > 0) {
    UIAccessibilityElement *img = [[UIAccessibilityElement alloc] initWithAccessibilityContainer:self];
    img.accessibilityLabel = _alt;
    img.accessibilityTraits = UIAccessibilityTraitImage;
    img.accessibilityFrameInContainerSpace = [self.contentView convertRect:_frameView.frame toView:self];
    [elements addObject:img];
  }
  [elements addObjectsFromArray:hosts];
  return elements;
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
