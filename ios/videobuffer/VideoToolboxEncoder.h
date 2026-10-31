#pragma once

#include "encode/EncoderBackend.h"

#include <memory>

namespace sherpa_onnx {
namespace video {

class VideoToolboxEncoder : public EncoderBackend {
 public:
  VideoToolboxEncoder();
  ~VideoToolboxEncoder() override;
  Status Configure(const VideoTrackInfo& track, int bitrate) override;
  Status Encode(const RawFrame& frame, std::vector<EncodedPacket>* out) override;
  Status Flush(std::vector<EncodedPacket>* out) override;
  void Close() override;
  std::vector<uint8_t> CodecConfig() const override;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace video
}  // namespace sherpa_onnx
