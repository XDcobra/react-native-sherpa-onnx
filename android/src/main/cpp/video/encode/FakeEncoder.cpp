#include "encode/FakeEncoder.h"

namespace sherpa_onnx {
namespace video {

namespace {

/** Minimal Baseline avcC (SPS/PPS for 64×48). Muxer smoke tests only. */
const uint8_t kFakeAvcc[] = {
    0x01, 0x42, 0xC0, 0x1E, 0xFF, 0xE1, 0x00, 0x08, 0x67, 0x42, 0xC0, 0x1E,
    0xDA, 0x02, 0x80, 0x2D, 0x01, 0x00, 0x05, 0x68, 0xCE, 0x0F, 0xC8, 0x80,
};

}  // namespace

Status FakeEncoder::Configure(const VideoTrackInfo& track, int bitrate) {
  (void)bitrate;
  if (track.codedWidth <= 0 || track.codedHeight <= 0) {
    return Status::Fail(kErrInvalidArgument, "encoder size");
  }
  track_ = track;
  configured_ = true;
  encodeCount_ = 0;
  flushCount_ = 0;
  codecConfig_.assign(kFakeAvcc, kFakeAvcc + sizeof(kFakeAvcc));
  return Status::Ok();
}

Status FakeEncoder::Encode(const RawFrame& frame,
                           std::vector<EncodedPacket>* out) {
  if (!configured_ || out == nullptr) {
    return Status::Fail(kErrEncodeFailed, "encoder");
  }
  if (frame.nv12.width <= 0 || frame.nv12.height <= 0 ||
      frame.nv12.y.data == nullptr) {
    return Status::Fail(kErrInvalidArgument, "empty nv12");
  }
  EncodedPacket pkt;
  pkt.ptsUs = frame.ptsUs;
  pkt.dtsUs = frame.ptsUs;
  if (encodeCount_ % keyInterval_ == 0) {
    pkt.flags = kSampleKey;
  }
  // 4-byte length + dummy IDR NAL (AVCC).
  pkt.payload = {0x00, 0x00, 0x00, 0x01, 0x65};
  out->push_back(std::move(pkt));
  ++encodeCount_;
  return Status::Ok();
}

Status FakeEncoder::Flush(std::vector<EncodedPacket>* out) {
  (void)out;
  if (!configured_) {
    return Status::Fail(kErrEncodeFailed, "encoder");
  }
  ++flushCount_;
  return Status::Ok();
}

void FakeEncoder::Close() {
  configured_ = false;
}

}  // namespace video
}  // namespace sherpa_onnx
