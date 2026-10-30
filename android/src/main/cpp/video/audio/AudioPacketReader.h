#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include "VideoTypes.h"
#include "audio/AudioTimeline.h"

namespace sherpa_onnx {
namespace video {

class VideoEntry;

class AudioPacketReader {
 public:
  explicit AudioPacketReader(std::shared_ptr<VideoEntry> entry);

  Status SeekTo(int64_t tUs);
  Result<EncodedPacket> Next(int timeoutMs);
  const AudioTrackInfo* track() const;
  bool eos() const { return eos_; }

 private:
  std::shared_ptr<VideoEntry> entry_;
  int64_t index_ = 0;
  bool eos_ = false;
};

}  // namespace video
}  // namespace sherpa_onnx
