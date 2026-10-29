#pragma once

#include <cstdint>
#include <string>

#include "VideoTypes.h"
#include "live/LiveVideoEntry.h"

namespace sherpa_onnx {
namespace video {

class VideoPacketReader {
 public:
  explicit VideoPacketReader(std::shared_ptr<VideoEntry> entry);

  Status SeekToKeyframe(int64_t tUs);
  /** Decode-order next packet. Live tail waits timeoutMs; Finish → EOS. */
  Result<EncodedPacket> Next(int timeoutMs);
  const std::vector<uint8_t>& codecConfig() const;
  bool eos() const { return eos_; }

 private:
  std::shared_ptr<VideoEntry> entry_;
  int64_t decodeIndex_ = 0;
  bool eos_ = false;
};

}  // namespace video
}  // namespace sherpa_onnx
