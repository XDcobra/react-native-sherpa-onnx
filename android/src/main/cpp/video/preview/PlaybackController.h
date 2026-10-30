#pragma once

#include "preview/PreviewTypes.h"

namespace sherpa_onnx {
namespace video {
namespace preview {

class PlaybackController {
 public:
  static HandleResult Handle(const ControllerState& state,
                             const PreviewInput& input, int64_t nowMediaUs,
                             int64_t nowNs = 0);
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
