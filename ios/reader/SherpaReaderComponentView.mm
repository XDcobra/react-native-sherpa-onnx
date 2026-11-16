#ifdef RCT_NEW_ARCH_ENABLED

#import "SherpaReaderComponentView.h"
#import "SherpaReaderCells.h"
#import "SherpaReaderInsertComponentView.h"

#import <React/RCTConversions.h>
#import <React/RCTFont.h>
#import <React/RCTLog.h>

#import <react/renderer/components/SherpaOnnxSpec/ComponentDescriptors.h>
#import <react/renderer/components/SherpaOnnxSpec/EventEmitters.h>
#import <react/renderer/components/SherpaOnnxSpec/Props.h>
#import <react/renderer/components/SherpaOnnxSpec/RCTComponentViewHelpers.h>

#include "ImageRegistry.h"
#include "ReaderLayout.h"
#include "ReaderHighlights.h"
#include "ReaderRegistry.h"
#include "ReaderTracker.h"

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

using namespace facebook::react;
namespace rdr = sherpa_onnx::reader;

namespace {

enum class RowKind { Block, Insert };

struct ReaderRow {
  RowKind kind;
  int blockIndex;  // Block rows: the block shown
  std::string insertKey;  // Insert rows
  // Block rows: blocks the row stands for (see reader/ReaderLayout.h).
  int coverFirst = -1;
  int coverLast = -1;
  bool page = false;  // a full-width page image
};

bool SameInserts(const std::vector<SherpaReaderViewInsertsStruct> &a,
                 const std::vector<SherpaReaderViewInsertsStruct> &b)
{
  if (a.size() != b.size()) {
    return false;
  }
  for (size_t i = 0; i < a.size(); ++i) {
    if (a[i].key != b[i].key || a[i].kind != b[i].kind || a[i].target != b[i].target) {
      return false;
    }
  }
  return true;
}

bool SameHighlights(const std::vector<SherpaReaderViewHighlightsStruct> &a,
                    const std::vector<SherpaReaderViewHighlightsStruct> &b)
{
  if (a.size() != b.size()) {
    return false;
  }
  for (size_t i = 0; i < a.size(); ++i) {
    const auto &x = a[i];
    const auto &y = b[i];
    if (x.id != y.id || x.fromBlockId != y.fromBlockId || x.fromOffset != y.fromOffset ||
        x.toBlockId != y.toBlockId || x.toOffset != y.toOffset || x.style != y.style ||
        x.color != y.color || x.hasColor != y.hasColor || x.follow != y.follow) {
      return false;
    }
  }
  return true;
}

bool SameSpans(const std::vector<rdr::HighlightSpan> &a, const std::vector<rdr::HighlightSpan> &b)
{
  if (a.size() != b.size()) {
    return false;
  }
  for (size_t i = 0; i < a.size(); ++i) {
    if (a[i].start != b[i].start || a[i].end != b[i].end || a[i].style != b[i].style ||
        a[i].color != b[i].color || a[i].hasColor != b[i].hasColor) {
      return false;
    }
  }
  return true;
}

UIColor *ColorFromARGB(uint32_t argb)
{
  return [UIColor colorWithRed:((argb >> 16) & 0xFF) / 255.0
                         green:((argb >> 8) & 0xFF) / 255.0
                          blue:(argb & 0xFF) / 255.0
                         alpha:((argb >> 24) & 0xFF) / 255.0];
}

NSString *ToNS(const std::string &s)
{
  return [NSString stringWithUTF8String:s.c_str()] ?: @"";
}

/** Inline italic / bold of a block (nil when it has none). */
NSArray<SherpaReaderStyleSpan *> *StyleSpans(const rdr::ReaderBlock &b)
{
  if (b.styles.empty()) return nil;
  NSMutableArray<SherpaReaderStyleSpan *> *out = [NSMutableArray arrayWithCapacity:b.styles.size()];
  for (const TxtStyleRun &r : b.styles) {
    if (r.end <= r.start) continue;
    SherpaReaderStyleSpan *span = [SherpaReaderStyleSpan new];
    span.range = NSMakeRange((NSUInteger)r.start, (NSUInteger)(r.end - r.start));
    span.italic = (r.flags & kTxtStyleItalic) != 0;
    span.bold = (r.flags & kTxtStyleBold) != 0;
    [out addObject:span];
  }
  return out;
}

}  // namespace

static NSString *const kTextCellId = @"SherpaReaderTextCell";
static NSString *const kImageCellId = @"SherpaReaderImageCell";
static NSString *const kSeparatorCellId = @"SherpaReaderSeparatorCell";
static NSString *const kInsertCellId = @"SherpaReaderInsertCell";

@interface SherpaReaderInsertCell : UITableViewCell
@property (nonatomic, weak, nullable) SherpaReaderInsertComponentView *host;
@end

@implementation SherpaReaderInsertCell

- (instancetype)initWithStyle:(UITableViewCellStyle)style reuseIdentifier:(NSString *)reuseIdentifier
{
  if (self = [super initWithStyle:style reuseIdentifier:reuseIdentifier]) {
    self.backgroundColor = UIColor.clearColor;
    self.contentView.backgroundColor = UIColor.clearColor;
    self.selectionStyle = UITableViewCellSelectionStyleNone;
    self.clipsToBounds = YES;
  }
  return self;
}

- (void)attachHost:(SherpaReaderInsertComponentView *)host
{
  for (UIView *sub in [self.contentView.subviews copy]) {
    if (sub != host && [sub isKindOfClass:SherpaReaderInsertComponentView.class]) {
      [sub removeFromSuperview];
    }
  }
  self.host = host;
  if (host.superview != self.contentView) {
    [host removeFromSuperview];
    [self.contentView addSubview:host];
  }
  CGRect frame = host.frame;
  frame.origin = CGPointZero;
  host.frame = frame;
}

@end

@interface SherpaReaderComponentView () <RCTSherpaReaderViewViewProtocol,
                                         UITableViewDataSource,
                                         UITableViewDelegate,
                                         UIGestureRecognizerDelegate>
@end

/** First visible row of the reader list: its identity and its distance to the top. */
@interface SherpaReaderAnchor : NSObject
@property (nonatomic, copy, nullable) NSString *identity;
@property (nonatomic) CGFloat delta;
@property (nonatomic) BOOL atTop;
@end

@implementation SherpaReaderAnchor
@end

@implementation SherpaReaderComponentView {
  UITableView *_tableView;
  UITapGestureRecognizer *_tap;
  NSMutableDictionary<NSString *, SherpaReaderInsertComponentView *> *_hostsByKey;
  // Measured heights of block rows (keyed by block ID). Returned as the
  // estimate so UIKit does not re-estimate rows above the viewport on updates.
  NSMutableDictionary<NSString *, NSNumber *> *_blockHeights;
  SherpaReaderTheme *_theme;

  std::shared_ptr<const rdr::ReaderSnapshot> _snap;
  std::vector<ReaderRow> _rows;
  std::vector<SherpaReaderViewInsertsStruct> _inserts;
  std::unique_ptr<rdr::ReaderTracker> _tracker;
  std::vector<SherpaReaderViewHighlightsStruct> _highlightProps;
  rdr::ResolvedHighlights _resolved;
  std::vector<std::string> _reportedInvalid;
  std::string _followMode;
  std::string _pageDisplay;
  CGFloat _followAnchor;
  BOOL _followPauseOnUser;
  BOOL _followPaused;
  BOOL _followAnimation;
  int _followedBlock;
  int _followedOffset;

  std::string _documentId;
  int _documentRevision;
  int _debugRowCount;
  std::string _initialBlockId;
  int _initialOffset;
  BOOL _initialApplied;
  std::string _furthestBlockId;
  int _furthestRevision;
  int _jumpThreshold;

  BOOL _rebuildScheduled;
  BOOL _readySent;
  BOOL _dragging;
  BOOL _programmaticAnimation;
  CFTimeInterval _lastOriginSync;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<SherpaReaderViewComponentDescriptor>();
}

+ (BOOL)shouldBeRecycled
{
  return NO;
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const SherpaReaderViewProps>();
    _props = defaultProps;
    _hostsByKey = [NSMutableDictionary new];
    _blockHeights = [NSMutableDictionary new];
    _initialOffset = -1;
    _jumpThreshold = 20;
    _tracker = std::make_unique<rdr::ReaderTracker>();
    _followMode = "keepVisible";
    _followAnchor = 0.3;
    _followPauseOnUser = YES;
    _followedBlock = -1;

    _tableView = [[UITableView alloc] initWithFrame:self.bounds style:UITableViewStylePlain];
    _tableView.dataSource = self;
    _tableView.delegate = self;
    _tableView.separatorStyle = UITableViewCellSeparatorStyleNone;
    _tableView.backgroundColor = UIColor.clearColor;
    _tableView.estimatedRowHeight = 80;
    _tableView.rowHeight = UITableViewAutomaticDimension;
    _tableView.allowsSelection = NO;
    _tableView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
    // Margins come from the theme / the app's layout; insert hosts must sit at
    // the same x as in React's layout.
    _tableView.insetsContentViewsToSafeArea = NO;
    _tableView.cellLayoutMarginsFollowReadableWidth = NO;
    [_tableView registerClass:SherpaReaderTextCell.class forCellReuseIdentifier:kTextCellId];
    [_tableView registerClass:SherpaReaderImageCell.class forCellReuseIdentifier:kImageCellId];
    [_tableView registerClass:SherpaReaderSeparatorCell.class forCellReuseIdentifier:kSeparatorCellId];
    [_tableView registerClass:SherpaReaderInsertCell.class forCellReuseIdentifier:kInsertCellId];

    _tap = [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(handleTap:)];
    _tap.cancelsTouchesInView = NO;
    _tap.delegate = self;
    [_tableView addGestureRecognizer:_tap];

    self.contentView = _tableView;
    _theme = [self themeFromProps:*defaultProps];

    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(contentSizeCategoryChanged)
                                                 name:UIContentSizeCategoryDidChangeNotification
                                               object:nil];
  }
  return self;
}

- (void)dealloc
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

#pragma mark - Props

- (SherpaReaderTheme *)themeFromProps:(const SherpaReaderViewProps &)p
{
  SherpaReaderTheme *t = [SherpaReaderTheme new];
  CGFloat size = p.fontSize > 0 ? p.fontSize : 18;
  if (p.fontScale < 0) {
    CGFloat scaled = [[UIFontMetrics metricsForTextStyle:UIFontTextStyleBody] scaledValueForValue:size];
    if (p.maxFontScale > 0) scaled = MIN(scaled, size * p.maxFontScale);
    size = scaled;
  } else if (p.fontScale > 0) {
    size *= p.fontScale;
  }
  UIFont *font = nil;
  if (!p.fontFamily.empty()) {
    font = [RCTFont updateFont:nil
                    withFamily:ToNS(p.fontFamily)
                          size:@(size)
                        weight:nil
                         style:nil
                       variant:nil
               scaleMultiplier:1];
  }
  if (!font) {
    UIFontDescriptor *serif = [[UIFont systemFontOfSize:size].fontDescriptor
        fontDescriptorWithDesign:UIFontDescriptorSystemDesignSerif];
    font = serif ? [UIFont fontWithDescriptor:serif size:size] : [UIFont systemFontOfSize:size];
  }
  t.bodyFont = font;
  t.lineHeightMultiple = p.lineHeight > 0 ? p.lineHeight : 1.5;
  t.paragraphSpacing = (p.paragraphSpacing >= 0 ? p.paragraphSpacing : 0.75) * size;
  t.marginHorizontal = p.readerMarginHorizontal;
  t.marginVertical = p.readerMarginVertical;
  t.alignment = p.textAlign == "justify" ? NSTextAlignmentJustified : NSTextAlignmentNatural;
  t.hyphenation = p.hyphenation;
  t.textColor = p.textColor ? RCTUIColorFromSharedColor(p.textColor) : UIColor.labelColor;
  t.accentColor = p.accentColor ? RCTUIColorFromSharedColor(p.accentColor) : self.tintColor;
  if (_snap && !_snap->language.empty()) t.language = ToNS(_snap->language);
  return t;
}

static bool ThemeChanged(const SherpaReaderViewProps &a, const SherpaReaderViewProps &b)
{
  return a.fontFamily != b.fontFamily || a.fontSize != b.fontSize || a.fontScale != b.fontScale ||
      a.maxFontScale != b.maxFontScale || a.lineHeight != b.lineHeight ||
      a.paragraphSpacing != b.paragraphSpacing || a.readerMarginHorizontal != b.readerMarginHorizontal ||
      a.readerMarginVertical != b.readerMarginVertical || a.textAlign != b.textAlign ||
      a.hyphenation != b.hyphenation || a.textColor != b.textColor || a.accentColor != b.accentColor;
}

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps
{
  const auto &oldP = static_cast<const SherpaReaderViewProps &>(*_props);
  const auto &newP = static_cast<const SherpaReaderViewProps &>(*props);
  BOOL rowsChanged = NO;
  BOOL themeChanged = ThemeChanged(oldP, newP);
  if (_documentId != newP.documentId || _documentRevision != newP.documentRevision ||
      _debugRowCount != newP.debugRowCount) {
    const bool newDocument = _documentId != newP.documentId;
    _documentId = newP.documentId;
    _documentRevision = newP.documentRevision;
    _debugRowCount = newP.debugRowCount;
    if (newDocument) {
      _initialApplied = NO;
      _readySent = NO;
      [_blockHeights removeAllObjects];
    }
    rowsChanged = YES;
  }
  if (!SameInserts(_inserts, newP.inserts)) {
    _inserts = newP.inserts;
    rowsChanged = YES;
  }
  if (_pageDisplay != newP.pageDisplay) {
    _pageDisplay = newP.pageDisplay;
    rowsChanged = YES;
  }
  if (!_initialApplied) {
    _initialBlockId = newP.initialBlockId;
    _initialOffset = newP.initialOffset;
  }
  if (_jumpThreshold != newP.jumpThreshold) {
    _jumpThreshold = newP.jumpThreshold;
    _tracker->SetJumpThreshold(_jumpThreshold);
  }
  const bool frontierChanged = _furthestRevision != newP.furthestRevision;
  _furthestRevision = newP.furthestRevision;
  _furthestBlockId = newP.furthestBlockId;
  [super updateProps:props oldProps:oldProps];
  if (frontierChanged && _snap) {
    _tracker->SetFrontier(_furthestBlockId.empty() ? -1 : _snap->BlockIndex(_furthestBlockId));
  }
  if (themeChanged) {
    _theme = [self themeFromProps:newP];
    [_blockHeights removeAllObjects];
    rowsChanged = YES;
  }
  const bool followModeChanged = _followMode != newP.followMode;
  _followMode = newP.followMode;
  _followAnchor = MIN(1, MAX(0, newP.followAnchor));
  _followPauseOnUser = newP.followPauseOnUserScroll;
  if (_followMode == "off" && _followPaused) {
    _followPaused = NO;
  }
  const bool highlightsChanged = !SameHighlights(_highlightProps, newP.highlights);
  if (highlightsChanged) {
    _highlightProps = newP.highlights;
  }
  if (rowsChanged) {
    // The rebuild resolves highlights against the new snapshot / theme.
    [self scheduleRebuild];
  } else if (highlightsChanged) {
    [self applyHighlights];
  } else if (followModeChanged) {
    [self followAnimated:YES force:YES];
  }
}

#pragma mark - Highlights and follow

/** Resolves `_highlightProps` against the snapshot; returns blocks whose spans changed. */
- (std::vector<int>)resolveHighlights
{
  std::vector<rdr::HighlightInput> inputs;
  inputs.reserve(_highlightProps.size());
  for (const auto &h : _highlightProps) {
    rdr::HighlightInput in;
    in.id = h.id;
    in.fromBlockId = h.fromBlockId;
    in.fromOffset = h.fromOffset;
    in.toBlockId = h.toBlockId;
    in.toOffset = h.toOffset;
    in.style = h.style == "underline" ? rdr::HighlightStyle::Underline
        : h.style == "textColor"      ? rdr::HighlightStyle::TextColor
                                      : rdr::HighlightStyle::Background;
    in.color = static_cast<uint32_t>(h.color);
    in.hasColor = h.hasColor;
    in.follow = h.follow;
    inputs.push_back(std::move(in));
  }
  rdr::ResolvedHighlights next;
  if (_snap) {
    next = rdr::ResolveHighlights(*_snap, inputs);
  }
  std::vector<int> changed;
  for (const auto &[block, spans] : next.byBlock) {
    auto it = _resolved.byBlock.find(block);
    if (it == _resolved.byBlock.end() || !SameSpans(it->second, spans)) changed.push_back(block);
  }
  for (const auto &[block, spans] : _resolved.byBlock) {
    if (next.byBlock.find(block) == next.byBlock.end()) changed.push_back(block);
  }
  _resolved = std::move(next);
  if (!_resolved.invalidIds.empty() && _resolved.invalidIds != _reportedInvalid) {
    std::string ids;
    for (const auto &id : _resolved.invalidIds) ids += (ids.empty() ? "" : ", ") + id;
    [self emitError:"ERR_READER_INVALID_ARGUMENT" message:"Unknown highlight range: " + ids];
  }
  _reportedInvalid = _resolved.invalidIds;
  return changed;
}

- (nullable NSArray<SherpaReaderHighlightSpan *> *)spansForBlock:(int)block
{
  auto it = _resolved.byBlock.find(block);
  if (it == _resolved.byBlock.end()) return nil;
  NSMutableArray<SherpaReaderHighlightSpan *> *out = [NSMutableArray arrayWithCapacity:it->second.size()];
  for (const auto &sp : it->second) {
    SherpaReaderHighlightSpan *h = [SherpaReaderHighlightSpan new];
    h.range = NSMakeRange(sp.start, sp.end - sp.start);
    h.style = (SherpaReaderHighlightStyle)sp.style;
    h.color = sp.hasColor ? ColorFromARGB(sp.color) : nil;
    [out addObject:h];
  }
  return out;
}

/** Highlights of the blocks a page row stands for, as marks on the page image. */
- (NSArray<SherpaReaderPageMark *> *)pageMarksForRow:(const ReaderRow &)row
{
  NSMutableArray<SherpaReaderPageMark *> *out = [NSMutableArray array];
  if (!_snap || !row.page || row.coverLast <= row.coverFirst) return out;
  for (int block = row.coverFirst; block <= row.coverLast; ++block) {
    auto it = _resolved.byBlock.find(block);
    if (it == _resolved.byBlock.end()) continue;
    for (const auto &sp : it->second) {
      UIColor *color = sp.hasColor ? ColorFromARGB(sp.color)
                       : sp.style == rdr::HighlightStyle::Background
                           ? [_theme.accentColor colorWithAlphaComponent:0.3]
                           : _theme.accentColor;
      for (const auto &r : rdr::TextRangeRects(*_snap, block, sp.start, sp.end)) {
        SherpaReaderPageMark *m = [SherpaReaderPageMark new];
        m.rect = CGRectMake(r.x, r.y, r.w, r.h);
        m.style = (SherpaReaderHighlightStyle)sp.style;
        m.color = color;
        [out addObject:m];
      }
    }
  }
  return out;
}

/** Applies changed highlights to visible rows in place, then follows. */
- (void)applyHighlights
{
  const std::vector<int> changed = [self resolveHighlights];
  for (NSIndexPath *path in _tableView.indexPathsForVisibleRows) {
    if (path.row >= (NSInteger)_rows.size()) continue;
    const auto &row = _rows[path.row];
    if (row.kind != RowKind::Block) continue;
    // A row changes when any block it stands for changed (page images cover their text).
    const bool touched = std::any_of(changed.begin(), changed.end(), [&](int b) {
      return b >= row.coverFirst && b <= row.coverLast;
    });
    if (!touched) continue;
    UITableViewCell *cell = [_tableView cellForRowAtIndexPath:path];
    if ([cell isKindOfClass:SherpaReaderTextCell.class]) {
      [(SherpaReaderTextCell *)cell updateHighlights:[self spansForBlock:row.blockIndex] theme:_theme];
    } else if ([cell isKindOfClass:SherpaReaderImageCell.class]) {
      [(SherpaReaderImageCell *)cell updatePageMarks:[self pageMarksForRow:row]];
    }
  }
  [self followAnimated:YES force:NO];
}

- (void)emitFollowChange:(BOOL)following reason:(const char *)reason
{
  if (auto emitter = std::static_pointer_cast<const SherpaReaderViewEventEmitter>(_eventEmitter)) {
    emitter->onFollowChange({(bool)following, reason});
  }
}

/** Content-space rect of the followed highlight's first line; NO if its row is not laid out. */
- (BOOL)followLineRect:(CGRect *)out
{
  if (_resolved.followBlock < 0) return NO;
  const NSInteger row = [self rowForBlock:_resolved.followBlock];
  if (row == NSNotFound) return NO;
  NSIndexPath *path = [NSIndexPath indexPathForRow:row inSection:0];
  UITableViewCell *cell = [_tableView cellForRowAtIndexPath:path];
  if (cell == nil) return NO;
  const CGRect r = [_tableView rectForRowAtIndexPath:path];
  CGFloat lineTop = 0;
  CGFloat lineHeight = ceil(_theme.bodyFont.lineHeight * _theme.lineHeightMultiple);
  const auto &target = _rows[row];
  if (target.page && target.blockIndex != _resolved.followBlock) {
    // On a page image: the followed text's line on the page.
    const auto rects = rdr::TextRangeRects(*_snap, _resolved.followBlock, _resolved.followOffset,
                                           _resolved.followOffset + 1);
    if (!rects.empty()) {
      lineTop = rects.front().y * r.size.height;
      lineHeight = MAX(1, rects.front().h * r.size.height);
    }
  } else if ([cell isKindOfClass:SherpaReaderTextCell.class]) {
    lineTop = [(SherpaReaderTextCell *)cell lineTopForCharacterOffset:_resolved.followOffset];
  }
  *out = CGRectMake(0, r.origin.y + lineTop, r.size.width, MIN(lineHeight, r.size.height));
  return YES;
}

/** True when the followed line lies in the comfort zone (10 %–85 % of the height). */
- (BOOL)followTargetInComfortZone
{
  CGRect line;
  if (![self followLineRect:&line]) return NO;
  const CGFloat h = _tableView.bounds.size.height;
  const CGFloat y = line.origin.y - _tableView.contentOffset.y;
  return y >= 0.10 * h && y + line.size.height <= 0.85 * h;
}

- (void)followAnimated:(BOOL)animated force:(BOOL)force
{
  [self followAnimated:animated force:force place:NO];
}

/**
 * Keeps the followed highlight in view. `force` re-checks even if the
 * highlight did not move (mode change, reflow); `place` moves it to the
 * anchor even when it is already in the comfort zone (resumeFollow).
 */
- (void)followAnimated:(BOOL)animated force:(BOOL)force place:(BOOL)place
{
  if (!_snap || _resolved.followBlock < 0) {
    _followedBlock = -1;
    return;
  }
  const bool moved = _resolved.followBlock != _followedBlock || _resolved.followOffset != _followedOffset;
  _followedBlock = _resolved.followBlock;
  _followedOffset = _resolved.followOffset;
  if ((!moved && !force) || _followMode == "off" || _dragging) return;
  if (_followPaused) {
    if (![self followTargetInComfortZone]) return;
    _followPaused = NO;
    [self emitFollowChange:YES reason:"resumed"];
  }
  CGRect line;
  if (![self followLineRect:&line]) {
    // Far away (row not laid out): jump there first, then place it exactly.
    const NSInteger row = [self rowForBlock:_resolved.followBlock];
    if (row == NSNotFound) return;
    NSIndexPath *path = [NSIndexPath indexPathForRow:row inSection:0];
    [_tableView scrollToRowAtIndexPath:path atScrollPosition:UITableViewScrollPositionTop animated:NO];
    [_tableView layoutIfNeeded];
    if (![self followLineRect:&line]) return;
    animated = NO;
  }
  const CGFloat h = _tableView.bounds.size.height;
  const CGFloat y = line.origin.y - _tableView.contentOffset.y;
  CGFloat target;
  if (_followMode == "center") {
    target = line.origin.y + line.size.height / 2 - h / 2;
  } else {
    if (!place && y >= 0.10 * h && y + line.size.height <= 0.85 * h) {
      if (!animated) {
        [self sampleWithPhase:rdr::ScrollPhase::Follow];
      }
      return;
    }
    target = line.origin.y - _followAnchor * h;
  }
  const CGFloat minY = -_tableView.contentInset.top;
  const CGFloat maxY = MAX(minY, _tableView.contentSize.height + _tableView.contentInset.bottom - h);
  target = MIN(maxY, MAX(minY, target));
  if (fabs(target - _tableView.contentOffset.y) < 1) {
    if (!animated) {
      [self sampleWithPhase:rdr::ScrollPhase::Follow];
    }
    return;
  }
  if (animated) {
    _followAnimation = YES;
    [_tableView setContentOffset:CGPointMake(0, target) animated:YES];
  } else {
    _tableView.contentOffset = CGPointMake(0, target);
    [self syncInsertOrigins];
    [self sampleWithPhase:rdr::ScrollPhase::Follow];
    [self sampleWithPhase:rdr::ScrollPhase::Idle];
  }
}

- (void)resumeFollow
{
  if (_followPaused) {
    _followPaused = NO;
    [self emitFollowChange:YES reason:"command"];
  }
  [self followAnimated:YES force:YES place:YES];
}

- (void)contentSizeCategoryChanged
{
  const auto &p = static_cast<const SherpaReaderViewProps &>(*_props);
  if (p.fontScale >= 0) return;
  _theme = [self themeFromProps:p];
  [_blockHeights removeAllObjects];
  [self scheduleRebuild];
}

#pragma mark - Children (insert hosts)

- (void)mountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView index:(NSInteger)index
{
  // Not calling super: hosts live in table rows, not as direct subviews.
  if (![childComponentView isKindOfClass:SherpaReaderInsertComponentView.class]) {
    RCTLogWarn(@"ReaderView children must be insert hosts; ignoring %@", childComponentView);
    return;
  }
  auto *host = (SherpaReaderInsertComponentView *)childComponentView;
  host.reader = self;
  if (host.insertKey.length > 0) {
    _hostsByKey[host.insertKey] = host;
  }
  [self scheduleRebuild];
}

- (void)unmountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView index:(NSInteger)index
{
  if (![childComponentView isKindOfClass:SherpaReaderInsertComponentView.class]) {
    return;
  }
  auto *host = (SherpaReaderInsertComponentView *)childComponentView;
  for (NSString *key in [_hostsByKey allKeysForObject:host]) {
    [_hostsByKey removeObjectForKey:key];
  }
  host.reader = nil;
  [host removeFromSuperview];
  [self scheduleRebuild];
}

- (void)insertHostDidChangeKey:(SherpaReaderInsertComponentView *)host
{
  for (NSString *key in [_hostsByKey allKeysForObject:host]) {
    [_hostsByKey removeObjectForKey:key];
  }
  if (host.insertKey.length > 0) {
    _hostsByKey[host.insertKey] = host;
  }
  [self scheduleRebuild];
}

- (void)insertHostDidResize:(SherpaReaderInsertComponentView *)host
{
  if (_rows.empty()) {
    return;
  }
  [self keepingAnchor:^{
    [UIView performWithoutAnimation:^{
      [self->_tableView beginUpdates];
      [self->_tableView endUpdates];
    }];
  }];
}

#pragma mark - Rows

- (void)scheduleRebuild
{
  // Fabric applies props, child mounts and layout in one transaction but in no
  // fixed order relative to each other; rebuild once after it has settled.
  if (_rebuildScheduled) {
    return;
  }
  _rebuildScheduled = YES;
  dispatch_async(dispatch_get_main_queue(), ^{
    self->_rebuildScheduled = NO;
    [self rebuildRows];
  });
}

- (void)appendInsertsOfKind:(const char *)kind target:(const std::string &)target to:(std::vector<ReaderRow> &)rows
{
  for (const auto &ins : _inserts) {
    if (ins.kind == kind && ins.target == target && _hostsByKey[ToNS(ins.key)] != nil) {
      rows.push_back({RowKind::Insert, -1, ins.key, -1, -1, false});
    }
  }
}

- (void)loadSnapshot
{
  std::shared_ptr<const rdr::ReaderSnapshot> next;
  if (!_documentId.empty()) {
    next = rdr::ReaderRegistry::Instance().Snapshot(_documentId);
    if (!next) {
      [self emitError:"ERR_READER_NOT_FOUND" message:"Reader document not found: " + _documentId];
    }
  } else if (_debugRowCount > 0) {
    next = rdr::MakePlaceholderSnapshot(_debugRowCount);
  }
  const bool changed = next != _snap;
  const std::string frontierId =
      (_snap && _tracker->Frontier() >= 0 && _tracker->Frontier() < (int)_snap->blocks.size())
      ? _snap->blocks[_tracker->Frontier()].id
      : std::string();
  _snap = next;
  if (!changed) return;
  // Flat indices change with app sections: rebuild the tracker around block IDs.
  std::vector<int> sectionLast;
  if (_snap) {
    for (const auto &s : _snap->sections) {
      if (s.blockCount > 0) sectionLast.push_back(s.firstBlock + s.blockCount - 1);
    }
  }
  _tracker = std::make_unique<rdr::ReaderTracker>(std::move(sectionLast), _jumpThreshold);
  const std::string frontier = !_furthestBlockId.empty() ? _furthestBlockId : frontierId;
  if (_snap && !frontier.empty()) _tracker->SetFrontier(_snap->BlockIndex(frontier));
  _theme = [self themeFromProps:static_cast<const SherpaReaderViewProps &>(*_props)];
}

- (void)rebuildRows
{
  // The first visible row, read from the rows and snapshot it was built from.
  SherpaReaderAnchor *anchor = [self captureAnchor];
  [self loadSnapshot];
  [self resolveHighlights];
  std::vector<ReaderRow> rows;
  if (_snap) {
    rows.reserve(_snap->blocks.size() + _inserts.size());
    // Rows per display mode; a row stands for the blocks it covers, and
    // inserts at covered blocks go before / after that row.
    const auto plan = rdr::PlanRows(*_snap, rdr::PageDisplayFromName(_pageDisplay.c_str()));
    for (const auto &p : plan) {
      for (int i = p.coverFirst; i <= p.coverLast; ++i) {
        [self appendInsertsOfKind:"beforeBlock" target:_snap->blocks[i].id to:rows];
      }
      rows.push_back({RowKind::Block, p.block, {}, p.coverFirst, p.coverLast, p.page});
      for (int i = p.coverFirst; i <= p.coverLast; ++i) {
        [self appendInsertsOfKind:"afterBlock" target:_snap->blocks[i].id to:rows];
      }
      const auto &sec = _snap->sections[_snap->blocks[p.coverLast].section];
      if (p.coverLast == sec.firstBlock + sec.blockCount - 1) {
        [self appendInsertsOfKind:"sectionEnd" target:sec.id to:rows];
      }
    }
    for (const auto &sec : _snap->sections) {
      if (sec.blockCount == 0) [self appendInsertsOfKind:"sectionEnd" target:sec.id to:rows];
    }
  }
  _tableView.contentInset = UIEdgeInsetsMake(_theme.marginVertical, 0, _theme.marginVertical, 0);
  _rows = std::move(rows);
  [_tableView reloadData];
  [_tableView layoutIfNeeded];
  [self restoreAnchor:anchor];

  if (!_snap || _snap->blocks.empty()) return;
  if (!_initialApplied) {
    _initialApplied = YES;
    const int block = _initialBlockId.empty() ? -1 : _snap->BlockIndex(_initialBlockId);
    if (block >= 0) {
      [self scrollToBlock:block offset:_initialOffset animated:NO];
    }
  }
  [self sampleWithPhase:rdr::ScrollPhase::Layout];
  // Reflow (theme, revision) may have moved the followed highlight.
  [self followAnimated:NO force:YES];
  if (!_readySent) {
    _readySent = YES;
    if (auto emitter = std::static_pointer_cast<const SherpaReaderViewEventEmitter>(_eventEmitter)) {
      emitter->onReaderReady({(int)_snap->blocks.size(), (int)_snap->sections.size()});
    }
  }
}

- (NSString *)identityOfRow:(NSInteger)row
{
  if (row < 0 || row >= (NSInteger)_rows.size()) {
    return nil;
  }
  const auto &r = _rows[row];
  if (r.kind == RowKind::Insert) return [@"i:" stringByAppendingString:ToNS(r.insertKey)];
  return _snap ? [@"b:" stringByAppendingString:ToNS(_snap->blocks[r.blockIndex].id)] : nil;
}

- (NSInteger)rowForIdentity:(NSString *)identity
{
  for (NSInteger i = 0; i < (NSInteger)_rows.size(); ++i) {
    if ([[self identityOfRow:i] isEqualToString:identity]) {
      return i;
    }
  }
  return NSNotFound;
}

/** Row that shows or covers `blockIndex`. */
- (NSInteger)rowForBlock:(int)blockIndex
{
  for (NSInteger i = 0; i < (NSInteger)_rows.size(); ++i) {
    const auto &r = _rows[i];
    if (r.kind == RowKind::Block && blockIndex >= r.coverFirst && blockIndex <= r.coverLast) return i;
  }
  return NSNotFound;
}

/** The first visible row (call before the rows or the snapshot change). */
- (SherpaReaderAnchor *)captureAnchor
{
  SherpaReaderAnchor *anchor = [SherpaReaderAnchor new];
  NSIndexPath *anchorPath = _tableView.indexPathsForVisibleRows.firstObject;
  anchor.identity = anchorPath ? [self identityOfRow:anchorPath.row] : nil;
  if (anchorPath) {
    anchor.delta = [_tableView rectForRowAtIndexPath:anchorPath].origin.y - _tableView.contentOffset.y;
  }
  anchor.atTop = _tableView.contentOffset.y <= -_tableView.contentInset.top;
  return anchor;
}

/** Puts the anchor row back at the same screen position. */
- (void)restoreAnchor:(SherpaReaderAnchor *)anchor
{
  dispatch_async(dispatch_get_main_queue(), ^{
    [self syncInsertOrigins];
  });
  if (anchor.identity == nil || anchor.atTop) {
    return;
  }
  CGFloat delta = anchor.delta;
  NSInteger row = [self rowForIdentity:anchor.identity];
  if (row == NSNotFound && _snap && [anchor.identity hasPrefix:@"b:"]) {
    // The anchor row is gone (OCR text in place of a page image): the row that
    // now covers its block, from its top.
    const int block = _snap->BlockIndex(std::string([anchor.identity substringFromIndex:2].UTF8String ?: ""));
    row = block >= 0 ? [self rowForBlock:block] : NSNotFound;
    delta = 0;
  }
  if (row == NSNotFound) {
    return;
  }
  CGFloat y = [_tableView rectForRowAtIndexPath:[NSIndexPath indexPathForRow:row inSection:0]].origin.y - delta;
  CGFloat maxY = MAX(-_tableView.contentInset.top,
                     _tableView.contentSize.height + _tableView.contentInset.bottom - _tableView.bounds.size.height);
  _tableView.contentOffset = CGPointMake(0, MIN(MAX(-_tableView.contentInset.top, y), maxY));
}

/** Runs `updates` (same snapshot) and keeps the first visible row at the same screen position. */
- (void)keepingAnchor:(void (^)(void))updates
{
  SherpaReaderAnchor *anchor = [self captureAnchor];
  updates();
  [self restoreAnchor:anchor];
}

#pragma mark - UITableViewDataSource / Delegate

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section
{
  return (NSInteger)_rows.size();
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath
{
  const auto &row = _rows[indexPath.row];
  if (row.kind == RowKind::Insert) {
    auto *cell = (SherpaReaderInsertCell *)[tableView dequeueReusableCellWithIdentifier:kInsertCellId
                                                                           forIndexPath:indexPath];
    SherpaReaderInsertComponentView *host = _hostsByKey[ToNS(row.insertKey)];
    if (host) {
      [cell attachHost:host];
    }
    return cell;
  }
  const rdr::ReaderBlock &b = _snap->blocks[row.blockIndex];
  if (b.type == rdr::ReaderBlockType::Image || b.type == rdr::ReaderBlockType::Page) {
    auto *cell = (SherpaReaderImageCell *)[tableView dequeueReusableCellWithIdentifier:kImageCellId
                                                                          forIndexPath:indexPath];
    [cell configureWithBufferId:(b.imageFrame >= 0 ? ToNS(_snap->imageBufferId) : nil)
                     frameIndex:b.imageFrame
                            alt:(b.hasAlt ? ToNS(b.alt) : nil)
                          theme:_theme
                           page:row.page];
    [cell updatePageMarks:[self pageMarksForRow:row]];
    return cell;
  }
  if (b.type == rdr::ReaderBlockType::Separator) {
    auto *cell = (SherpaReaderSeparatorCell *)[tableView dequeueReusableCellWithIdentifier:kSeparatorCellId
                                                                              forIndexPath:indexPath];
    [cell configureWithTheme:_theme];
    return cell;
  }
  auto *cell = (SherpaReaderTextCell *)[tableView dequeueReusableCellWithIdentifier:kTextCellId
                                                                       forIndexPath:indexPath];
  [cell configureWithText:ToNS(_snap->BlockText(row.blockIndex))
             headingLevel:(b.type == rdr::ReaderBlockType::Heading ? b.headingLevel : 0)
                   styles:StyleSpans(b)
               highlights:[self spansForBlock:row.blockIndex]
                    theme:_theme];
  return cell;
}

- (CGFloat)imageRowHeight:(const rdr::ReaderBlock &)b page:(bool)page
{
  if (b.imageFrame < 0 || !_snap) return 0;
  sherpa_onnx::image::ImageFrameInfo info;
  // Expected size: lazy pages are laid out before they are decoded.
  if (!sherpa_onnx::image::ImageRegistry::Instance().GetFrameInfo(_snap->imageBufferId, b.imageFrame, info) ||
      info.expectedWidth <= 0 || info.expectedHeight <= 0) {
    return 0;
  }
  if (page) {
    // A page: full width, its own height (pages follow each other).
    return ceil(_tableView.bounds.size.width * info.expectedHeight / (CGFloat)info.expectedWidth);
  }
  const CGFloat width = MAX(1, _tableView.bounds.size.width - 2 * _theme.marginHorizontal);
  const CGFloat height =
      MIN(width * info.expectedHeight / (CGFloat)info.expectedWidth, _tableView.bounds.size.height * 0.9);
  return ceil(height + 1.5 * _theme.paragraphSpacing);
}

- (CGFloat)tableView:(UITableView *)tableView heightForRowAtIndexPath:(NSIndexPath *)indexPath
{
  const auto &row = _rows[indexPath.row];
  if (row.kind == RowKind::Insert) {
    SherpaReaderInsertComponentView *host = _hostsByKey[ToNS(row.insertKey)];
    return host ? MAX(0, host.yogaHeight) : 0;
  }
  const rdr::ReaderBlock &b = _snap->blocks[row.blockIndex];
  if (b.type == rdr::ReaderBlockType::Image || b.type == rdr::ReaderBlockType::Page) {
    return [self imageRowHeight:b page:row.page];
  }
  if (b.type == rdr::ReaderBlockType::Separator) return ceil(_theme.bodyFont.lineHeight * 1.5);
  return UITableViewAutomaticDimension;
}

- (CGFloat)tableView:(UITableView *)tableView estimatedHeightForRowAtIndexPath:(NSIndexPath *)indexPath
{
  const auto &row = _rows[indexPath.row];
  if (row.kind == RowKind::Insert) {
    SherpaReaderInsertComponentView *host = _hostsByKey[ToNS(row.insertKey)];
    return host ? MAX(1, host.yogaHeight) : 1;
  }
  const rdr::ReaderBlock &b = _snap->blocks[row.blockIndex];
  NSNumber *measured = _blockHeights[ToNS(b.id)];
  if (measured) return measured.doubleValue;
  if (b.type == rdr::ReaderBlockType::Image || b.type == rdr::ReaderBlockType::Page) {
    return MAX(1, [self imageRowHeight:b page:row.page]);
  }
  if (b.type == rdr::ReaderBlockType::Separator) return ceil(_theme.bodyFont.lineHeight * 1.5);
  // Rough guess from the text length: ~0.5 em per character.
  const CGFloat width = MAX(1, tableView.bounds.size.width - 2 * _theme.marginHorizontal);
  const CGFloat chars = MAX(1, (CGFloat)b.textUtf16Len);
  const CGFloat fontSize = _theme.bodyFont.pointSize;
  const CGFloat lines = MAX(1, ceil(chars * fontSize * 0.5 / width));
  return lines * fontSize * _theme.lineHeightMultiple * 1.2 + _theme.paragraphSpacing;
}

- (void)tableView:(UITableView *)tableView
      willDisplayCell:(UITableViewCell *)cell
    forRowAtIndexPath:(NSIndexPath *)indexPath
{
  if (indexPath.row >= (NSInteger)_rows.size()) return;
  const auto &row = _rows[indexPath.row];
  if (row.kind == RowKind::Block && _snap) {
    _blockHeights[ToNS(_snap->blocks[row.blockIndex].id)] = @(cell.bounds.size.height);
  } else if (row.kind == RowKind::Insert) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self syncInsertOrigins];
    });
  }
}

#pragma mark - Insert positions for `measure`

/** Pushes every visible insert host's position (reader coordinates) into its shadow state. */
- (void)syncInsertOrigins
{
  _lastOriginSync = CACurrentMediaTime();
  for (UITableViewCell *cell in _tableView.visibleCells) {
    if (![cell isKindOfClass:SherpaReaderInsertCell.class]) {
      continue;
    }
    SherpaReaderInsertComponentView *host = ((SherpaReaderInsertCell *)cell).host;
    if (host != nil && host.superview == cell.contentView) {
      [host setOnScreenOrigin:[host convertPoint:CGPointZero toView:self]];
    }
  }
}

- (void)layoutSubviews
{
  const CGFloat oldWidth = _tableView.bounds.size.width;
  [super layoutSubviews];
  if (oldWidth > 0 && _tableView.bounds.size.width != oldWidth) {
    // Width change (rotation): text reflows, re-measure while keeping the anchor.
    [_blockHeights removeAllObjects];
    [self keepingAnchor:^{
      [self->_tableView reloadData];
      [self->_tableView layoutIfNeeded];
    }];
    [self sampleWithPhase:rdr::ScrollPhase::Layout];
    [self followAnimated:NO force:YES];
  }
  [self syncInsertOrigins];
}

#pragma mark - Visibility and events

/**
 * First / last visible block (flat indices). A block counts when at least half
 * of min(its height, the viewport) is on screen.
 */
- (BOOL)visibleBlocksFirst:(int *)first last:(int *)last inserts:(std::vector<std::string> *)inserts
{
  *first = -1;
  *last = -1;
  const CGFloat top = _tableView.contentOffset.y;
  const CGFloat bottom = top + _tableView.bounds.size.height;
  const CGFloat viewport = _tableView.bounds.size.height;
  for (NSIndexPath *path in _tableView.indexPathsForVisibleRows) {
    const auto &row = _rows[path.row];
    const CGRect r = [_tableView rectForRowAtIndexPath:path];
    const CGFloat shown = MIN(CGRectGetMaxY(r), bottom) - MAX(CGRectGetMinY(r), top);
    if (row.kind == RowKind::Insert) {
      if (shown > 0 && inserts) inserts->push_back(row.insertKey);
      continue;
    }
    if (r.size.height <= 0 || shown <= 0) continue;
    // Shared rule (half of min(height, viewport); blocks on a page image by
    // their rectangle); covered blocks count with their row.
    const rdr::ReaderRow plan{row.blockIndex, row.coverFirst, row.coverLast, row.page};
    int f = -1;
    int l = -1;
    if (!rdr::RowVisibleBlocks(*_snap, plan, (float)MAX(0, top - CGRectGetMinY(r)),
                               (float)(MIN(CGRectGetMaxY(r), bottom) - CGRectGetMinY(r)),
                               (float)r.size.height, (float)viewport, &f, &l)) {
      continue;
    }
    if (*first < 0 || f < *first) *first = f;
    if (l > *last) *last = l;
  }
  return *first >= 0;
}

/** UTF-16 offset of the first visible character in the first visible block. */
- (int)firstVisibleOffset:(int)firstBlock
{
  const NSInteger row = [self rowForBlock:firstBlock];
  // Only the block's own text row has offsets (not a row that covers it).
  if (row == NSNotFound || _rows[row].blockIndex != firstBlock) return 0;
  UITableViewCell *cell = [_tableView cellForRowAtIndexPath:[NSIndexPath indexPathForRow:row inSection:0]];
  if (![cell isKindOfClass:SherpaReaderTextCell.class]) return 0;
  const CGPoint top = [_tableView convertPoint:CGPointMake(_theme.marginHorizontal + 1,
                                                           _tableView.contentOffset.y + 1)
                                        toView:cell.contentView];
  if (top.y <= 0) return 0;
  return (int)[(SherpaReaderTextCell *)cell characterOffsetAtPoint:top];
}

- (void)sampleWithPhase:(rdr::ScrollPhase)phase
{
  if (!_snap || _snap->blocks.empty()) return;
  int first = -1;
  int last = -1;
  std::vector<std::string> inserts;
  if (![self visibleBlocksFirst:&first last:&last inserts:&inserts]) return;
  auto emitter = std::static_pointer_cast<const SherpaReaderViewEventEmitter>(_eventEmitter);
  const auto events = _tracker->Sample(first, last, phase);
  if (!emitter) return;
  auto sectionOf = [&](int block) { return _snap->sections[_snap->blocks[block].section].id; };
  for (const auto &e : events) {
    switch (e.kind) {
      case rdr::TrackerEvent::Kind::VisibleRange:
        emitter->onVisibleRangeChange({sectionOf(e.first), _snap->blocks[e.first].id, sectionOf(e.last),
                                       _snap->blocks[e.last].id, e.settled ? [self firstVisibleOffset:e.first] : 0,
                                       e.settled, inserts});
        break;
      case rdr::TrackerEvent::Kind::Furthest:
        emitter->onFurthestPositionChange({sectionOf(e.block), _snap->blocks[e.block].id, -1});
        break;
      case rdr::TrackerEvent::Kind::SectionEnd:
        emitter->onSectionEnd({sectionOf(e.block), _snap->blocks[e.block].id});
        break;
      case rdr::TrackerEvent::Kind::Jump:
        emitter->onJump({sectionOf(e.from), _snap->blocks[e.from].id, sectionOf(e.to), _snap->blocks[e.to].id,
                         e.distance, e.cause});
        break;
    }
  }
}

- (void)emitError:(const char *)code message:(const std::string &)message
{
  if (auto emitter = std::static_pointer_cast<const SherpaReaderViewEventEmitter>(_eventEmitter)) {
    emitter->onReaderError({code, message});
  }
}

#pragma mark - Scrolling

- (void)cancelReactTouches
{
  // A drag inside the reader must cancel the JS responder (e.g. a Pressable in
  // an insert), the same way RCTSurfaceTouchHandler cancels for outer scroll
  // views. Toggling `enabled` sends touchcancel to JS.
  for (UIView *v = self; v != nil; v = v.superview) {
    for (UIGestureRecognizer *gr in v.gestureRecognizers) {
      if ([NSStringFromClass(gr.class) isEqualToString:@"RCTSurfaceTouchHandler"]) {
        gr.enabled = NO;
        gr.enabled = YES;
        return;
      }
    }
  }
}

- (void)scrollViewWillBeginDragging:(UIScrollView *)scrollView
{
  _dragging = YES;
  _programmaticAnimation = NO;
  _followAnimation = NO;
  if (_followPauseOnUser && !_followPaused && _resolved.followBlock >= 0 && _followMode != "off") {
    _followPaused = YES;
    [self emitFollowChange:NO reason:"user"];
  }
  [self cancelReactTouches];
}

- (void)scrollViewDidScroll:(UIScrollView *)scrollView
{
  if (_dragging) {
    [self sampleWithPhase:rdr::ScrollPhase::Drag];
  } else if (scrollView.isDecelerating) {
    [self sampleWithPhase:rdr::ScrollPhase::Momentum];
  } else if (_followAnimation) {
    [self sampleWithPhase:rdr::ScrollPhase::Follow];
  }
  // Throttled: Pressability measures on touch-down; at rest the sync is exact.
  if (CACurrentMediaTime() - _lastOriginSync > 0.05) {
    [self syncInsertOrigins];
  }
}

- (void)scrollViewDidEndDragging:(UIScrollView *)scrollView willDecelerate:(BOOL)decelerate
{
  _dragging = NO;
  if (!decelerate) {
    [self settle];
  } else {
    [self sampleWithPhase:rdr::ScrollPhase::Momentum];
  }
}

- (void)scrollViewDidEndDecelerating:(UIScrollView *)scrollView
{
  [self settle];
}

- (void)scrollViewDidEndScrollingAnimation:(UIScrollView *)scrollView
{
  if (_programmaticAnimation) {
    _programmaticAnimation = NO;
    [self sampleWithPhase:rdr::ScrollPhase::Programmatic];
  }
  if (_followAnimation) {
    _followAnimation = NO;
    [self sampleWithPhase:rdr::ScrollPhase::Follow];
  }
  [self settle];
}

- (void)settle
{
  [self syncInsertOrigins];
  [self sampleWithPhase:rdr::ScrollPhase::Idle];
  // The user scrolled the followed highlight back into the comfort zone.
  if (_followPaused && !_dragging && [self followTargetInComfortZone]) {
    _followPaused = NO;
    [self emitFollowChange:YES reason:"resumed"];
  }
}

#pragma mark - Tap

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldReceiveTouch:(UITouch *)touch
{
  for (UIView *v = touch.view; v != nil && v != _tableView; v = v.superview) {
    if ([v isKindOfClass:SherpaReaderInsertComponentView.class]) {
      return NO;
    }
  }
  return YES;
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
    shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)other
{
  return YES;
}

- (void)handleTap:(UITapGestureRecognizer *)tap
{
  NSIndexPath *path = [_tableView indexPathForRowAtPoint:[tap locationInView:_tableView]];
  if (!_snap || path == nil || path.row >= (NSInteger)_rows.size() || _rows[path.row].kind != RowKind::Block) {
    return;
  }
  if (auto emitter = std::static_pointer_cast<const SherpaReaderViewEventEmitter>(_eventEmitter)) {
    emitter->onReaderTap({_snap->blocks[_rows[path.row].blockIndex].id});
  }
}

#pragma mark - Commands

- (void)handleCommand:(const NSString *)commandName args:(const NSArray *)args
{
  RCTSherpaReaderViewHandleCommand(self, commandName, args);
}

/** Scrolls so `block` (and the line holding `offset`) is at the top. */
- (void)scrollToBlock:(int)block offset:(int)offset animated:(BOOL)animated
{
  const NSInteger row = [self rowForBlock:block];
  if (row == NSNotFound) return;
  NSIndexPath *path = [NSIndexPath indexPathForRow:row inSection:0];
  if (animated && offset <= 0) {
    _programmaticAnimation = YES;
    [_tableView scrollToRowAtIndexPath:path atScrollPosition:UITableViewScrollPositionTop animated:YES];
    return;
  }
  // Two steps: jump with estimated heights, lay out, then correct to the exact row (and line).
  [_tableView scrollToRowAtIndexPath:path atScrollPosition:UITableViewScrollPositionTop animated:NO];
  [_tableView layoutIfNeeded];
  [_tableView scrollToRowAtIndexPath:path atScrollPosition:UITableViewScrollPositionTop animated:NO];
  [_tableView layoutIfNeeded];
  const auto &target = _rows[row];
  if (target.blockIndex != block) {
    // A covered block: its place on the page image, else the row's top.
    const CGRect r = [_tableView rectForRowAtIndexPath:path];
    const rdr::ReaderRow plan{target.blockIndex, target.coverFirst, target.coverLast, target.page};
    const CGFloat dy = rdr::BlockOffsetInRow(*_snap, plan, block, (float)r.size.height);
    const CGFloat maxY = MAX(-_tableView.contentInset.top,
                             _tableView.contentSize.height + _tableView.contentInset.bottom -
                                 _tableView.bounds.size.height);
    _tableView.contentOffset = CGPointMake(0, MIN(maxY, r.origin.y + dy));
  } else if (offset > 0) {
    UITableViewCell *cell = [_tableView cellForRowAtIndexPath:path];
    if ([cell isKindOfClass:SherpaReaderTextCell.class]) {
      const CGFloat lineTop = [(SherpaReaderTextCell *)cell lineTopForCharacterOffset:offset];
      const CGRect r = [_tableView rectForRowAtIndexPath:path];
      const CGFloat maxY = MAX(-_tableView.contentInset.top,
                               _tableView.contentSize.height + _tableView.contentInset.bottom -
                                   _tableView.bounds.size.height);
      _tableView.contentOffset = CGPointMake(0, MIN(maxY, r.origin.y + lineTop));
    }
  }
  [self syncInsertOrigins];
}

- (void)scrollToLocator:(NSString *)sectionId blockId:(NSString *)blockId offset:(NSInteger)offset animated:(BOOL)animated
{
  if (!_snap) return;
  int block = _snap->BlockIndex(std::string(blockId.UTF8String ?: ""));
  if (block < 0) {
    const int sec = _snap->SectionIndex(std::string(sectionId.UTF8String ?: ""));
    if (sec >= 0 && _snap->sections[sec].blockCount > 0) block = _snap->sections[sec].firstBlock;
  }
  if (block < 0) {
    [self emitError:"ERR_READER_INVALID_ARGUMENT" message:"Unknown locator: " + std::string(blockId.UTF8String ?: "")];
    return;
  }
  [self scrollToBlock:block offset:(int)offset animated:animated];
  if (!animated || offset > 0) {
    [self sampleWithPhase:rdr::ScrollPhase::Programmatic];
    [self sampleWithPhase:rdr::ScrollPhase::Idle];
  }
}

@end

Class<RCTComponentViewProtocol> SherpaReaderViewCls(void)
{
  return SherpaReaderComponentView.class;
}

#endif
