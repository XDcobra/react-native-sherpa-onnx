#pragma once

#include <deque>
#include <mutex>

#include "decode/DecoderBackend.h"

namespace sherpa_onnx {
namespace video {

class VideoToolboxDecoder : public DecoderBackend {
 public:
  VideoToolboxDecoder();
  ~VideoToolboxDecoder() override;
  Status Configure(const VideoTrackInfo& track) override;
  Status Submit(const EncodedPacket& packet) override;
  Status Flush() override;
  bool Receive(DecodedRawFrame* out) override;
  void Close() override;
  int submitCount() const override { return submitCount_; }
  int flushCount() const override { return flushCount_; }
  void PushDecoded(DecodedRawFrame fr);

 private:
  void* session_ = nullptr;  // VTDecompressionSessionRef
  const void* format_ = nullptr;   // CMVideoFormatDescriptionRef
  std::deque<DecodedRawFrame> out_;
  std::mutex outMu_;
  VideoTrackInfo track_;
  int submitCount_ = 0;
  int flushCount_ = 0;
  bool configured_ = false;
};

}  // namespace video
}  // namespace sherpa_onnx
