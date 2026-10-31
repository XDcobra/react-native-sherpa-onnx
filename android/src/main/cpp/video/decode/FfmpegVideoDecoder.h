#pragma once

#ifdef HAVE_FFMPEG

#include "decode/DecoderBackend.h"

#include <deque>
#include <memory>
#include <mutex>

namespace sherpa_onnx {
namespace video {

/** Bundled SW H.264 / HEVC decoder. Registered only when avcodec_find_decoder
 *  finds the codec at runtime (ffmpeg-vsw variant). */
class FfmpegVideoDecoder : public DecoderBackend {
 public:
  FfmpegVideoDecoder();
  ~FfmpegVideoDecoder() override;
  Status Configure(const VideoTrackInfo& track) override;
  Status Submit(const EncodedPacket& packet) override;
  Status Flush() override;
  bool Receive(DecodedRawFrame* out) override;
  void Close() override;
  int submitCount() const override { return submitCount_; }
  int flushCount() const override { return flushCount_; }

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  int submitCount_ = 0;
  int flushCount_ = 0;
  bool configured_ = false;
  std::mutex outMu_;
  std::deque<DecodedRawFrame> out_;
};

}  // namespace video
}  // namespace sherpa_onnx

#endif  // HAVE_FFMPEG
