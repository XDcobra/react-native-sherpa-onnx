#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

class VideoEntry;

struct AudioExtractOptions {
  int64_t rangeStartUs = 0;
  int64_t rangeEndUs = -1;  // < 0 → audio track end
  int targetSampleRate = 16000;  // 0 → keep source rate
};

struct AudioExtractResult {
  int64_t numSamples = 0;
  int sampleRate = 0;
  int64_t mediaStartUs = 0;
  std::string sourceCodec;
  int sourceSampleRate = 0;
  int sourceChannels = 0;
  std::string path;
};

class VideoAudioExtractor {
 public:
  using ProgressFn = std::function<void(int percent, int64_t decodedMs)>;

  static Status Run(std::shared_ptr<VideoEntry> entry,
                    const AudioExtractOptions& opts, const std::string& outPath,
                    std::atomic<bool>* cancel, ProgressFn progress,
                    AudioExtractResult* out);
};

}  // namespace video
}  // namespace sherpa_onnx
