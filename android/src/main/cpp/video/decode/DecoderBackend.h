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
  /**
   * Pop one decoded frame, blocking up to `timeoutUs` for decoder output.
   * Default: non-blocking `Receive`. HW backends override (MediaCodec dequeue
   * timeout / VideoToolbox wait-for-async).
   */
  virtual bool ReceiveWait(DecodedRawFrame* out, int64_t timeoutUs) {
    (void)timeoutUs;
    return Receive(out);
  }
  virtual void Close() = 0;
  virtual int submitCount() const = 0;
  virtual int flushCount() const = 0;
  virtual bool IsReclaimed() const { return false; }
};

using DecoderFactory = std::function<std::unique_ptr<DecoderBackend>()>;

void RegisterDecoderFactory(DecoderFactory factory);
DecoderFactory GetDecoderFactory();
void ResetDecoderFactoryForTest();

/** Register a platform MediaCodec / VT / fake provider into the codec catalog. */
void RegisterNamedVideoCodec(const char* name, const char* codec, bool encoder,
                             bool hardware, int minW, int minH, int maxW,
                             int maxH, int alignW, int alignH,
                             int64_t maxBlocks, int blockW, int blockH,
                             int maxInstances, double fps1080Low);

/** Open a decoder for a catalog provider (fake / ffmpeg / MediaCodec / VT). */
std::unique_ptr<DecoderBackend> OpenDecoderForProvider(
    const std::string& providerName);

using NamedDecoderOpener =
    std::function<std::unique_ptr<DecoderBackend>(const std::string&)>;
void SetNamedDecoderOpener(NamedDecoderOpener opener);

/** Runtime-detect FFmpeg h264/hevc SW decoders and register them. */
void RegisterBundledVideoSwDecoders();

}  // namespace video
}  // namespace sherpa_onnx
