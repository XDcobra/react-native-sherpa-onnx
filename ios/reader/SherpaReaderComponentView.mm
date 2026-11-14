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
#include "ReaderRegistry.h"
#include "ReaderTracker.h"

#include <memory>
#include <string>
#include <vector>

using namespace facebook::react;
namespace rdr = sherpa_onnx::reader;

namespace {

enum class RowKind { Block, Insert };

struct ReaderRow {
  RowKind kind;
  int blockIndex;  // Block rows
  std::string insertKey;  // Insert rows
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

NSString *ToNS(const std::string &s)
{
  return [NSString stringWithUTF8String:s.c_str()] ?: @"";
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
  t.marginHorizontal = p.marginHorizontal;
  t.marginVertical = p.marginVertical;
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
      a.paragraphSpacing != b.paragraphSpacing || a.marginHorizontal != b.marginHorizontal ||
      a.marginVertical != b.marginVertical || a.textAlign != b.textAlign ||
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
  if (rowsChanged) {
    [self scheduleRebuild];
  }
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
      rows.push_back({RowKind::Insert, -1, ins.key});
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
  [self loadSnapshot];
  std::vector<ReaderRow> rows;
  if (_snap) {
    rows.reserve(_snap->blocks.size() + _inserts.size());
    for (const auto &sec : _snap->sections) {
      for (int k = 0; k < sec.blockCount; ++k) {
        const int i = sec.firstBlock + k;
        const std::string &blockId = _snap->blocks[i].id;
        [self appendInsertsOfKind:"beforeBlock" target:blockId to:rows];
        rows.push_back({RowKind::Block, i, {}});
        [self appendInsertsOfKind:"afterBlock" target:blockId to:rows];
      }
      [self appendInsertsOfKind:"sectionEnd" target:sec.id to:rows];
    }
  }
  _tableView.contentInset = UIEdgeInsetsMake(_theme.marginVertical, 0, _theme.marginVertical, 0);
  [self keepingAnchor:^{
    self->_rows = std::move(rows);
    [self->_tableView reloadData];
    [self->_tableView layoutIfNeeded];
  }];

  if (!_snap || _snap->blocks.empty()) return;
  if (!_initialApplied) {
    _initialApplied = YES;
    const int block = _initialBlockId.empty() ? -1 : _snap->BlockIndex(_initialBlockId);
    if (block >= 0) {
      [self scrollToBlock:block offset:_initialOffset animated:NO];
    }
  }
  [self sampleWithPhase:rdr::ScrollPhase::Layout];
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

- (NSInteger)rowForBlock:(int)blockIndex
{
  for (NSInteger i = 0; i < (NSInteger)_rows.size(); ++i) {
    if (_rows[i].kind == RowKind::Block && _rows[i].blockIndex == blockIndex) return i;
  }
  return NSNotFound;
}

/** Runs `updates` and keeps the first visible row at the same screen position. */
- (void)keepingAnchor:(void (^)(void))updates
{
  NSIndexPath *anchorPath = _tableView.indexPathsForVisibleRows.firstObject;
  NSString *anchorId = anchorPath ? [self identityOfRow:anchorPath.row] : nil;
  CGFloat delta = 0;
  if (anchorPath) {
    delta = [_tableView rectForRowAtIndexPath:anchorPath].origin.y - _tableView.contentOffset.y;
  }
  BOOL atTop = _tableView.contentOffset.y <= -_tableView.contentInset.top;
  updates();
  dispatch_async(dispatch_get_main_queue(), ^{
    [self syncInsertOrigins];
  });
  if (anchorId == nil || atTop) {
    return;
  }
  NSInteger row = [self rowForIdentity:anchorId];
  if (row == NSNotFound) {
    return;
  }
  CGFloat y = [_tableView rectForRowAtIndexPath:[NSIndexPath indexPathForRow:row inSection:0]].origin.y - delta;
  CGFloat maxY = MAX(-_tableView.contentInset.top,
                     _tableView.contentSize.height + _tableView.contentInset.bottom - _tableView.bounds.size.height);
  _tableView.contentOffset = CGPointMake(0, MIN(MAX(-_tableView.contentInset.top, y), maxY));
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
  if (b.type == rdr::ReaderBlockType::Image) {
    auto *cell = (SherpaReaderImageCell *)[tableView dequeueReusableCellWithIdentifier:kImageCellId
                                                                          forIndexPath:indexPath];
    [cell configureWithBufferId:(b.imageFrame >= 0 ? ToNS(_snap->imageBufferId) : nil)
                     frameIndex:b.imageFrame
                            alt:(b.hasAlt ? ToNS(b.alt) : nil)
                          theme:_theme];
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
                    theme:_theme];
  return cell;
}

- (CGFloat)imageRowHeight:(const rdr::ReaderBlock &)b
{
  if (b.imageFrame < 0 || !_snap) return 0;
  sherpa_onnx::image::ImageFrameInfo info;
  if (!sherpa_onnx::image::ImageRegistry::Instance().GetFrameInfo(_snap->imageBufferId, b.imageFrame, info) ||
      info.width <= 0 || info.height <= 0) {
    return 0;
  }
  const CGFloat width = MAX(1, _tableView.bounds.size.width - 2 * _theme.marginHorizontal);
  const CGFloat height = MIN(width * info.height / (CGFloat)info.width, _tableView.bounds.size.height * 0.9);
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
  if (b.type == rdr::ReaderBlockType::Image) return [self imageRowHeight:b];
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
  if (b.type == rdr::ReaderBlockType::Image) return MAX(1, [self imageRowHeight:b]);
  if (b.type == rdr::ReaderBlockType::Separator) return ceil(_theme.bodyFont.lineHeight * 1.5);
  // Rough guess from the text length: ~0.5 em per character.
  const CGFloat width = MAX(1, tableView.bounds.size.width - 2 * _theme.marginHorizontal);
  const CGFloat chars = MAX(1, (CGFloat)(b.fromFile ? (b.utf16End - b.utf16Start) : b.appText.size()));
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
    if (r.size.height <= 0 || shown < 0.5 * MIN(r.size.height, viewport)) continue;
    if (*first < 0) *first = row.blockIndex;
    *last = row.blockIndex;
  }
  return *first >= 0;
}

/** UTF-16 offset of the first visible character in the first visible block. */
- (int)firstVisibleOffset:(int)firstBlock
{
  const NSInteger row = [self rowForBlock:firstBlock];
  if (row == NSNotFound) return 0;
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
  [self cancelReactTouches];
}

- (void)scrollViewDidScroll:(UIScrollView *)scrollView
{
  if (_dragging) {
    [self sampleWithPhase:rdr::ScrollPhase::Drag];
  } else if (scrollView.isDecelerating) {
    [self sampleWithPhase:rdr::ScrollPhase::Momentum];
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
  [self settle];
}

- (void)settle
{
  [self syncInsertOrigins];
  [self sampleWithPhase:rdr::ScrollPhase::Idle];
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
  if (offset > 0) {
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
