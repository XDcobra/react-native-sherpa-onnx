#pragma once

#ifdef __ANDROID__

#include "decode/DecoderBackend.h"

#include <media/NdkImage.h>
#include <media/NdkImageReader.h>
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <vector>

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
  bool ReceiveWait(DecodedRawFrame* out, int64_t timeoutUs) override;
  void Close() override;
  int submitCount() const override { return submitCount_; }
  int flushCount() const override { return flushCount_; }
  bool IsReclaimed() const override { return reclaimed_; }
  void SetAllowedCodecName(std::string name) { allowedName_ = std::move(name); }

  static void SetGlobalHwDecoderName(VideoCodec codec, std::string name);
  static std::string GlobalHwDecoderName(VideoCodec codec);
  static void ApplyCsd(AMediaFormat* fmt, VideoCodec codec,
                       const std::vector<uint8_t>& config);

 private:
  static void OnImageAvailable(void* context, AImageReader* reader);
  Status CopyImageToFrame(AImage* image, DecodedRawFrame* out, int64_t ptsUs);
  void PumpCodec(int64_t timeoutUs);
  void DrainImages();
  void DiscardImages();
  bool PopDecoded(DecodedRawFrame* out);

  AMediaCodec* codec_ = nullptr;
  AImageReader* reader_ = nullptr;
  ANativeWindow* window_ = nullptr;
  AImageReader_ImageListener listener_{};
  VideoTrackInfo track_;
  std::string allowedName_;
  int submitCount_ = 0;
  int flushCount_ = 0;
  bool configured_ = false;
  bool queuedSinceStart_ = false;
  bool reclaimed_ = false;
  std::atomic<uint64_t> imageGen_{0};
  std::mutex outMu_;
  std::condition_variable outCv_;
  std::deque<int64_t> pendingPtsUs_;
  std::deque<DecodedRawFrame> out_;
};

}  // namespace video
}  // namespace sherpa_onnx

#endif  // __ANDROID__
