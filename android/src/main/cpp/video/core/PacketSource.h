#pragma once

#include <cstdint>
#include <functional>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

class PacketSource {
 public:
  virtual ~PacketSource() = default;
  virtual const VideoTrackInfo& track() const = 0;
  virtual int64_t sampleCount() const = 0;
  virtual bool frameCountExact() const { return true; }
  virtual IndexState indexState() const { return IndexState::Complete; }
  virtual Status GetSample(int64_t decodeIndex, SampleEntry* out) const = 0;
  virtual Status ReadPacket(int64_t decodeIndex, EncodedPacket* out) = 0;
};

}  // namespace video
}  // namespace sherpa_onnx
