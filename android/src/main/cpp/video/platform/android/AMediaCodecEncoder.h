#pragma once

#ifdef __ANDROID__

#include "encode/EncoderBackend.h"

#include <string>
#include <vector>

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
  std::vector<uint8_t> CodecConfig() const override { return codecConfig_; }
  void SetAllowedCodecName(std::string name) { allowedName_ = std::move(name); }

  static void SetGlobalHwEncoderName(VideoCodec codec, std::string name);
  static std::string GlobalHwEncoderName(VideoCodec codec);

 private:
  Status DrainOutputs(std::vector<EncodedPacket>* out, int64_t timeoutUs,
                      bool untilEos);

  AMediaCodec* codec_ = nullptr;
  std::string allowedName_;
  bool configured_ = false;
  bool sawEos_ = false;
  int fps_ = 30;
  std::vector<uint8_t> codecConfig_;
  std::vector<uint8_t> packed_;
};

}  // namespace video
}  // namespace sherpa_onnx

#endif
