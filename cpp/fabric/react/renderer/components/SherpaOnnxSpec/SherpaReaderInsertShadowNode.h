#pragma once

#include <react/renderer/components/SherpaOnnxSpec/EventEmitters.h>
#include <react/renderer/components/SherpaOnnxSpec/Props.h>
#include <react/renderer/components/SherpaOnnxSpec/SherpaReaderInsertState.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {

JSI_EXPORT extern const char SherpaReaderInsertViewComponentName[];

/**
 * Shadow node of a ReaderView insert host. The native list moves the host's
 * view into a row; the row position is pushed into the state and reported as
 * the content origin offset, so descendants measure where they are on screen.
 */
class SherpaReaderInsertShadowNode final : public ConcreteViewShadowNode<
                                               SherpaReaderInsertViewComponentName,
                                               SherpaReaderInsertViewProps,
                                               SherpaReaderInsertViewEventEmitter,
                                               SherpaReaderInsertState> {
 public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  Point getContentOriginOffset(bool includeTransform) const override;
};

} // namespace facebook::react
