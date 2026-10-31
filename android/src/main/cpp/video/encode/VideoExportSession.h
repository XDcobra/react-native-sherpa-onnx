#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>

#include "VideoTypes.h"
#include "codec/CodecTypes.h"

#include <optional>

namespace sherpa_onnx {
namespace video {

struct VideoExportOptions {
  VideoCodec codec = VideoCodec::H264;
  int bitrate = 2'000'000;
  int64_t fromUs = 0;
  int64_t toUs = -1;
  int maxSide = 0;
  std::optional<sherpa_onnx::codec::Policy> decodePolicy;
  std::optional<sherpa_onnx::codec::Policy> encodePolicy;
  sherpa_onnx::codec::Decision decoderDecision;
  sherpa_onnx::codec::Decision encoderDecision;
};

class VideoExportSession {
 public:
  using ProgressFn = std::function<void(int percent, int64_t encodedUs)>;

  static Status Run(const std::string& bufferId, const std::string& outPath,
                    const std::string& format, VideoExportOptions& opts,
                    std::atomic<bool>* cancel, ProgressFn progress);
};

}  // namespace video
}  // namespace sherpa_onnx
