#pragma once

#include <functional>
#include <memory>
#include <string>

#include "VideoTypes.h"
#include "core/AlignedBuffer.h"

namespace sherpa_onnx {
namespace video {

struct DecodedRawFrame {
  AlignedBuffer storage;
  Nv12View view;
  int64_t ptsUs = 0;
  int64_t presentationIndex = -1;
};

class DecoderBackend {
 public:
  virtual ~DecoderBackend() = default;
  virtual Status Configure(const VideoTrackInfo& track) = 0;
  virtual Status Submit(const EncodedPacket& packet) = 0;
  virtual Status Flush() = 0;
  /** Pop one decoded frame; returns false if the output queue is empty. */
  virtual bool Receive(DecodedRawFrame* out) = 0;
  virtual void Close() = 0;
  virtual int submitCount() const = 0;
  virtual int flushCount() const = 0;
};

using DecoderFactory = std::function<std::unique_ptr<DecoderBackend>()>;

void RegisterDecoderFactory(DecoderFactory factory);
DecoderFactory GetDecoderFactory();
void ResetDecoderFactoryForTest();

}  // namespace video
}  // namespace sherpa_onnx
