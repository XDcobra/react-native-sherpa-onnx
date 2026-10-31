#pragma once

#include <functional>
#include <memory>
#include <vector>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

struct RawFrame {
  Nv12View nv12;
  int64_t ptsUs = 0;
};

class EncoderBackend {
 public:
  virtual ~EncoderBackend() = default;
  virtual Status Configure(const VideoTrackInfo& track, int bitrate) = 0;
  virtual Status Encode(const RawFrame& frame,
                        std::vector<EncodedPacket>* out) = 0;
  virtual Status Flush(std::vector<EncodedPacket>* out) = 0;
  virtual void Close() = 0;
  /** avcC / hvcC (or Annex-B parameter sets) collected from codec-config buffers. */
  virtual std::vector<uint8_t> CodecConfig() const { return {}; }
};

using EncoderFactory = std::function<std::unique_ptr<EncoderBackend>()>;

void RegisterEncoderFactory(EncoderFactory factory);
EncoderFactory GetEncoderFactory();
void ResetEncoderFactoryForTest();

}  // namespace video
}  // namespace sherpa_onnx
