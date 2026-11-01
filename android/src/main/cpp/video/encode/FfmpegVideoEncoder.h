#pragma once

#ifdef HAVE_FFMPEG

#include "encode/EncoderBackend.h"

#include <memory>

namespace sherpa_onnx {
namespace video {

/** Bundled VP9 encoder via FFmpeg `libvpx_vp9`. Available when FFmpeg was
 *  built with libvpx (runtime `avcodec_find_encoder_by_name`). */
class FfmpegVideoEncoder : public EncoderBackend {
 public:
  FfmpegVideoEncoder();
  ~FfmpegVideoEncoder() override;
  Status Configure(const VideoTrackInfo& track, int bitrate) override;
  Status Encode(const RawFrame& frame, std::vector<EncodedPacket>* out) override;
  Status Flush(std::vector<EncodedPacket>* out) override;
  void Close() override;
  std::vector<uint8_t> CodecConfig() const override { return codecConfig_; }

 private:
  Status Drain(std::vector<EncodedPacket>* out);
  void CaptureExtradata();

  struct Impl;
  std::unique_ptr<Impl> impl_;
  VideoTrackInfo track_;
  std::vector<uint8_t> codecConfig_;
  bool configured_ = false;
  int packetCount_ = 0;
};

}  // namespace video
}  // namespace sherpa_onnx

#endif  // HAVE_FFMPEG
