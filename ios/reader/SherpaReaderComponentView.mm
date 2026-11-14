#ifdef RCT_NEW_ARCH_ENABLED

#import "SherpaReaderComponentView.h"
#import "SherpaReaderInsertComponentView.h"

#import <React/RCTConversions.h>
#import <React/RCTLog.h>

#import <react/renderer/components/SherpaOnnxSpec/ComponentDescriptors.h>
#import <react/renderer/components/SherpaOnnxSpec/EventEmitters.h>
#import <react/renderer/components/SherpaOnnxSpec/Props.h>
#import <react/renderer/components/SherpaOnnxSpec/RCTComponentViewHelpers.h>

#include <string>
#include <vector>

using namespace facebook::react;

namespace {

enum class RowKind { Block, Insert };

struct ReaderRow {
  RowKind kind;
  int blockIndex; // Block rows
  std::string insertKey; // Insert rows
};

// Spike data source: placeholder blocks, 10 per section.
constexpr int kDebugBlocksPerSection = 10;

std::string DebugSectionId(int blockIndex)
{
  return "s" + std::to_string(blockIndex / kDebugBlocksPerSection);
}

std::string DebugBlockId(int blockIndex)
{
  return DebugSectionId(blockIndex) + ".b" + std::to_string(blockIndex % kDebugBlocksPerSection);
}

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

} // namespace

static NSString *const kBlockCellId = @"SherpaReaderBlockCell";
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
  // Measured heights of block rows (keyed by block index). Returned as the
  // estimate so UIKit does not re-estimate rows above the viewport on updates.
  NSMutableDictionary<NSNumber *, NSNumber *> *_blockHeights;
  std::vector<ReaderRow> _rows;
  std::vector<SherpaReaderViewInsertsStruct> _inserts;
  int _debugRowCount;
  BOOL _rebuildScheduled;
  BOOL _readySent;
  int _lastFirstBlock;
  int _lastLastBlock;
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
    _lastFirstBlock = -1;
    _lastLastBlock = -1;

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
    [_tableView registerClass:UITableViewCell.class forCellReuseIdentifier:kBlockCellId];
    [_tableView registerClass:SherpaReaderInsertCell.class forCellReuseIdentifier:kInsertCellId];

    _tap = [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(handleTap:)];
    _tap.cancelsTouchesInView = NO;
    _tap.delegate = self;
    [_tableView addGestureRecognizer:_tap];

    self.contentView = _tableView;
  }
  return self;
}

#pragma mark - Props

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps
{
  const auto &newP = static_cast<const SherpaReaderViewProps &>(*props);
  BOOL rowsChanged = NO;
  if (_debugRowCount != newP.debugRowCount) {
    _debugRowCount = newP.debugRowCount;
    rowsChanged = YES;
  }
  if (!SameInserts(_inserts, newP.inserts)) {
    _inserts = newP.inserts;
    rowsChanged = YES;
  }
  [super updateProps:props oldProps:oldProps];
  if (rowsChanged) {
    [self scheduleRebuild];
  }
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

- (void)rebuildRows
{
  std::vector<ReaderRow> rows;
  const int blockCount = _debugRowCount;
  rows.reserve(blockCount + _inserts.size());
  for (int i = 0; i < blockCount; ++i) {
    const std::string blockId = DebugBlockId(i);
    [self appendInsertsOfKind:"beforeBlock" target:blockId to:rows];
    rows.push_back({RowKind::Block, i, {}});
    [self appendInsertsOfKind:"afterBlock" target:blockId to:rows];
    const bool lastInSection = (i + 1) % kDebugBlocksPerSection == 0 || i + 1 == blockCount;
    if (lastInSection) {
      [self appendInsertsOfKind:"sectionEnd" target:DebugSectionId(i) to:rows];
    }
  }
  [self keepingAnchor:^{
    self->_rows = std::move(rows);
    [self->_tableView reloadData];
    [self->_tableView layoutIfNeeded];
  }];

  if (!_readySent && blockCount > 0) {
    _readySent = YES;
    if (auto emitter = std::static_pointer_cast<const SherpaReaderViewEventEmitter>(_eventEmitter)) {
      emitter->onReaderReady({blockCount, (blockCount + kDebugBlocksPerSection - 1) / kDebugBlocksPerSection});
    }
  }
}

- (NSString *)identityOfRow:(NSInteger)row
{
  if (row < 0 || row >= (NSInteger)_rows.size()) {
    return nil;
  }
  const auto &r = _rows[row];
  return r.kind == RowKind::Block ? [NSString stringWithFormat:@"b:%d", r.blockIndex]
                                  : [@"i:" stringByAppendingString:ToNS(r.insertKey)];
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

/** Runs `updates` and keeps the first visible row at the same screen position. */
- (void)keepingAnchor:(void (^)(void))updates
{
  NSIndexPath *anchorPath = _tableView.indexPathsForVisibleRows.firstObject;
  NSString *anchorId = anchorPath ? [self identityOfRow:anchorPath.row] : nil;
  CGFloat delta = 0;
  if (anchorPath) {
    delta = [_tableView rectForRowAtIndexPath:anchorPath].origin.y - _tableView.contentOffset.y;
  }
  BOOL atTop = _tableView.contentOffset.y <= 0;
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
  CGFloat maxY = MAX(0, _tableView.contentSize.height - _tableView.bounds.size.height);
  _tableView.contentOffset = CGPointMake(0, MIN(MAX(0, y), maxY));
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
  UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:kBlockCellId forIndexPath:indexPath];
  cell.backgroundColor = UIColor.clearColor;
  cell.selectionStyle = UITableViewCellSelectionStyleNone;
  cell.textLabel.numberOfLines = 0;
  cell.textLabel.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
  cell.textLabel.adjustsFontForContentSizeCategory = YES;
  const int i = row.blockIndex;
  NSMutableString *text = [NSMutableString stringWithFormat:@"%s — ", DebugBlockId(i).c_str()];
  for (int k = 0; k <= i % 4; ++k) {
    [text appendString:@"The quick brown fox jumps over the lazy dog. "];
  }
  cell.textLabel.text = text;
  return cell;
}

- (CGFloat)tableView:(UITableView *)tableView heightForRowAtIndexPath:(NSIndexPath *)indexPath
{
  const auto &row = _rows[indexPath.row];
  if (row.kind == RowKind::Insert) {
    SherpaReaderInsertComponentView *host = _hostsByKey[ToNS(row.insertKey)];
    return host ? MAX(0, host.yogaHeight) : 0;
  }
  return UITableViewAutomaticDimension;
}

- (CGFloat)tableView:(UITableView *)tableView estimatedHeightForRowAtIndexPath:(NSIndexPath *)indexPath
{
  const auto &row = _rows[indexPath.row];
  if (row.kind == RowKind::Insert) {
    SherpaReaderInsertComponentView *host = _hostsByKey[ToNS(row.insertKey)];
    return host ? MAX(1, host.yogaHeight) : 1;
  }
  NSNumber *measured = _blockHeights[@(row.blockIndex)];
  return measured ? measured.doubleValue : 80;
}

- (void)tableView:(UITableView *)tableView
      willDisplayCell:(UITableViewCell *)cell
    forRowAtIndexPath:(NSIndexPath *)indexPath
{
  if ([cell isKindOfClass:SherpaReaderInsertCell.class]) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self syncInsertOrigins];
    });
  }
  if (indexPath.row < (NSInteger)_rows.size() && _rows[indexPath.row].kind == RowKind::Block) {
    _blockHeights[@(_rows[indexPath.row].blockIndex)] = @(cell.bounds.size.height);
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
  [super layoutSubviews];
  [self syncInsertOrigins];
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
  [self cancelReactTouches];
}

- (void)scrollViewDidScroll:(UIScrollView *)scrollView
{
  [self emitVisibleRangeSettled:NO];
  // Throttled: Pressability measures on touch-down; at rest the sync below is exact.
  if (CACurrentMediaTime() - _lastOriginSync > 0.05) {
    [self syncInsertOrigins];
  }
}

- (void)scrollViewDidEndDragging:(UIScrollView *)scrollView willDecelerate:(BOOL)decelerate
{
  if (!decelerate) {
    [self emitVisibleRangeSettled:YES];
  }
}

- (void)scrollViewDidEndDecelerating:(UIScrollView *)scrollView
{
  [self emitVisibleRangeSettled:YES];
}

- (void)scrollViewDidEndScrollingAnimation:(UIScrollView *)scrollView
{
  [self emitVisibleRangeSettled:YES];
}

- (void)emitVisibleRangeSettled:(BOOL)settled
{
  if (settled) {
    [self syncInsertOrigins];
  }
  int first = -1;
  int last = -1;
  std::vector<std::string> insertKeys;
  for (NSIndexPath *path in _tableView.indexPathsForVisibleRows) {
    const auto &row = _rows[path.row];
    if (row.kind == RowKind::Block) {
      if (first < 0) {
        first = row.blockIndex;
      }
      last = row.blockIndex;
    } else {
      insertKeys.push_back(row.insertKey);
    }
  }
  if (first < 0) {
    return;
  }
  if (!settled && first == _lastFirstBlock && last == _lastLastBlock) {
    return;
  }
  _lastFirstBlock = first;
  _lastLastBlock = last;
  if (auto emitter = std::static_pointer_cast<const SherpaReaderViewEventEmitter>(_eventEmitter)) {
    emitter->onVisibleRangeChange({DebugSectionId(first), DebugBlockId(first), DebugSectionId(last),
                                   DebugBlockId(last), 0, (bool)settled, insertKeys});
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
  if (path == nil || path.row >= (NSInteger)_rows.size() || _rows[path.row].kind != RowKind::Block) {
    return;
  }
  if (auto emitter = std::static_pointer_cast<const SherpaReaderViewEventEmitter>(_eventEmitter)) {
    emitter->onReaderTap({DebugBlockId(_rows[path.row].blockIndex)});
  }
}

#pragma mark - Commands

- (void)handleCommand:(const NSString *)commandName args:(const NSArray *)args
{
  RCTSherpaReaderViewHandleCommand(self, commandName, args);
}

- (void)scrollToLocator:(NSString *)sectionId blockId:(NSString *)blockId offset:(NSInteger)offset animated:(BOOL)animated
{
  for (NSInteger i = 0; i < (NSInteger)_rows.size(); ++i) {
    if (_rows[i].kind == RowKind::Block && [ToNS(DebugBlockId(_rows[i].blockIndex)) isEqualToString:blockId]) {
      [_tableView scrollToRowAtIndexPath:[NSIndexPath indexPathForRow:i inSection:0]
                        atScrollPosition:UITableViewScrollPositionTop
                                animated:animated];
      if (!animated) {
        [self emitVisibleRangeSettled:YES];
      }
      return;
    }
  }
}

@end

Class<RCTComponentViewProtocol> SherpaReaderViewCls(void)
{
  return SherpaReaderComponentView.class;
}

#endif
