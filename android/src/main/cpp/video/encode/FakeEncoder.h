#pragma once

#include "encode/EncoderBackend.h"

namespace sherpa_onnx {
namespace video {

/** Host-test encoder: copies a dummy NAL per input frame. */
class FakeEncoder : public EncoderBackend {
 public:
  Status Configure(const VideoTrackInfo& track, int bitrate) override;
  Status Encode(const RawFrame& frame, std::vector<EncodedPacket>* out) override;
  Status Flush(std::vector<EncodedPacket>* out) override;
  void Close() override;
  std::vector<uint8_t> CodecConfig() const override { return codecConfig_; }

  int encodeCount() const { return encodeCount_; }
  int flushCount() const { return flushCount_; }

 private:
  VideoTrackInfo track_;
  bool configured_ = false;
  int encodeCount_ = 0;
  int flushCount_ = 0;
  int keyInterval_ = 15;
  std::vector<uint8_t> codecConfig_;
};

}  // namespace video
}  // namespace sherpa_onnx
