#pragma once

#include <string>

#include "VideoTypes.h"
#include "live/LiveVideoEntry.h"

namespace sherpa_onnx {
namespace video {

enum class IngestPacing { Realtime, AsFast };

struct LiveIngestOptions {
  IngestPacing pacing = IngestPacing::AsFast;
  bool includeAudio = true;
};

class LiveIngest {
 public:
  /** File → live packet remux (no transcode). Requires FFmpeg. */
  static Status Run(const std::string& path, LiveVideoEntry* live,
                    const LiveIngestOptions& opts);
};

}  // namespace video
}  // namespace sherpa_onnx
