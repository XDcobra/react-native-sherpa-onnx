#pragma once

#ifdef __ANDROID__

#include "encode/EncoderBackend.h"

#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>

namespace sherpa_onnx {
namespace video {

class AMediaCodecEncoder : public EncoderBackend {
 public:
  AMediaCodecEncoder();
  ~AMediaCodecEncoder() override;
  Status Configure(const VideoTrackInfo& track, int bitrate) override;
  Status Encode(const RawFrame& frame, std::vector<EncodedPacket>* out) override;
  Status Flush(std::vector<EncodedPacket>* out) override;
  void Close() override;
  void SetAllowedCodecName(std::string name) { allowedName_ = std::move(name); }

  static void SetGlobalHwEncoderName(VideoCodec codec, std::string name);
  static std::string GlobalHwEncoderName(VideoCodec codec);

 private:
  AMediaCodec* codec_ = nullptr;
  std::string allowedName_;
  bool configured_ = false;
};

}  // namespace video
}  // namespace sherpa_onnx

#endif
