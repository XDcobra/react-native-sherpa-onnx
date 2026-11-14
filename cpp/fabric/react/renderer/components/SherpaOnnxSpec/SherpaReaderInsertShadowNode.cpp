#include "SherpaReaderInsertShadowNode.h"

namespace facebook::react {

extern const char SherpaReaderInsertViewComponentName[] = "SherpaReaderInsertView";

Point SherpaReaderInsertShadowNode::getContentOriginOffset(bool /*includeTransform*/) const
{
  return getStateData().originOffset;
}

} // namespace facebook::react
