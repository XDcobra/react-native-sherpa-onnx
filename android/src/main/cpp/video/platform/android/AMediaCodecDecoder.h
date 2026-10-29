#pragma once

#ifdef __ANDROID__

#include "decode/DecoderBackend.h"

#include <media/NdkImage.h>
#include <media/NdkImageReader.h>
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>

namespace sherpa_onnx {
namespace video {

class AMediaCodecDecoder : public DecoderBackend {
 public:
  AMediaCodecDecoder();
  ~AMediaCodecDecoder() override;
  Status Configure(const VideoTrackInfo& track) override;
  Status Submit(const EncodedPacket& packet) override;
  Status Flush() override;
  bool Receive(DecodedRawFrame* out) override;
  void Close() override;
  int submitCount() const override { return submitCount_; }
  int flushCount() const override { return flushCount_; }
  void SetAllowedCodecName(std::string name) { allowedName_ = std::move(name); }

  static void SetGlobalHwDecoderName(VideoCodec codec, std::string name);
  static std::string GlobalHwDecoderName(VideoCodec codec);

 private:
  Status CopyImageToFrame(AImage* image, DecodedRawFrame* out, int64_t ptsUs);

  AMediaCodec* codec_ = nullptr;
  AImageReader* reader_ = nullptr;
  ANativeWindow* window_ = nullptr;
  VideoTrackInfo track_;
  std::string allowedName_;
  int submitCount_ = 0;
  int flushCount_ = 0;
  bool configured_ = false;
};

}  // namespace video
}  // namespace sherpa_onnx

#endif  // __ANDROID__
