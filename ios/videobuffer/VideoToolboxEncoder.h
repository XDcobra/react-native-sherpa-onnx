#pragma once

#include "encode/EncoderBackend.h"

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

 private:
  void* session_ = nullptr;
  bool configured_ = false;
};

}  // namespace video
}  // namespace sherpa_onnx
