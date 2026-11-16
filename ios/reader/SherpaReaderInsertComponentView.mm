#ifdef RCT_NEW_ARCH_ENABLED

#import "SherpaReaderInsertComponentView.h"
#import "SherpaReaderComponentView.h"

#import <react/renderer/components/SherpaOnnxSpec/Props.h>
#import <react/renderer/components/SherpaOnnxSpec/SherpaReaderInsertComponentDescriptor.h>
#import <react/renderer/components/SherpaOnnxSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@interface SherpaReaderInsertComponentView () <RCTSherpaReaderInsertViewViewProtocol>
@end

@implementation SherpaReaderInsertComponentView {
  NSString *_insertKey;
  SherpaReaderInsertShadowNode::ConcreteState::Shared _state;
  CGPoint _lastOrigin;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<SherpaReaderInsertViewComponentDescriptor>();
}

// Hosts get moved between table cells; never hand one back to the recycle pool
// while a cell may still reference it.
+ (BOOL)shouldBeRecycled
{
  return NO;
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const SherpaReaderInsertViewProps>();
    _props = defaultProps;
    _insertKey = @"";
  }
  return self;
}

- (NSString *)insertKey
{
  return _insertKey;
}

- (CGFloat)yogaHeight
{
  return _layoutMetrics.frame.size.height;
}

- (void)updateState:(const State::Shared &)state oldState:(const State::Shared &)oldState
{
  _state = std::static_pointer_cast<const SherpaReaderInsertShadowNode::ConcreteState>(state);
}

- (void)setOnScreenOrigin:(CGPoint)origin
{
  if (!_state) {
    return;
  }
  // Yoga places the host at the reader's origin; the offset is the full
  // on-screen position inside the reader.
  CGPoint offset = CGPointMake(origin.x - _layoutMetrics.frame.origin.x, origin.y - _layoutMetrics.frame.origin.y);
  if (fabs(offset.x - _lastOrigin.x) < 0.5 && fabs(offset.y - _lastOrigin.y) < 0.5) {
    return;
  }
  _lastOrigin = offset;
  _state->updateState(SherpaReaderInsertState{facebook::react::Point{(Float)offset.x, (Float)offset.y}});
}

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps
{
  const auto &newProps = static_cast<const SherpaReaderInsertViewProps &>(*props);
  NSString *key = [NSString stringWithUTF8String:newProps.insertKey.c_str()] ?: @"";
  BOOL keyChanged = ![key isEqualToString:_insertKey];
  _insertKey = key;
  [super updateProps:props oldProps:oldProps];
  if (keyChanged) {
    [self.reader insertHostDidChangeKey:self];
  }
}

- (void)updateLayoutMetrics:(const LayoutMetrics &)layoutMetrics
           oldLayoutMetrics:(const LayoutMetrics &)oldLayoutMetrics
{
  [super updateLayoutMetrics:layoutMetrics oldLayoutMetrics:oldLayoutMetrics];
  // Yoga places the host at the reader's origin; the row decides where it is
  // on screen, so keep the origin at the cell's top-left.
  CGRect frame = self.frame;
  frame.origin = CGPointZero;
  self.frame = frame;
  if (layoutMetrics.frame.size.height != oldLayoutMetrics.frame.size.height) {
    [self.reader insertHostDidResize:self];
  }
}

- (void)prepareForRecycle
{
  [super prepareForRecycle];
  _insertKey = @"";
  _state.reset();
  _lastOrigin = CGPointZero;
  self.reader = nil;
}

@end

Class<RCTComponentViewProtocol> SherpaReaderInsertViewCls(void)
{
  return SherpaReaderInsertComponentView.class;
}

#endif
