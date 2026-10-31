#include "decode/FakeDecoder.h"

#include "VideoLog.h"

#include <cstring>

namespace sherpa_onnx {
namespace video {
namespace {

struct Payload {
  int64_t presentationIndex = 0;
  int32_t width = 0;
  int32_t height = 0;
};

bool ParsePayload(const EncodedPacket& packet, Payload* out) {
  if (packet.payload.size() < sizeof(Payload) || out == nullptr) {
    return false;
  }
  std::memcpy(out, packet.payload.data(), sizeof(Payload));
  return true;
}

}  // namespace

uint8_t FakeDecoderBackend::IdentityLuma(int64_t presentationIndex) {
  if (presentationIndex < 0) {
    presentationIndex = 0;
  }
  return static_cast<uint8_t>(16 + (presentationIndex * 7) % 220);
}

EncodedPacket FakeDecoderBackend::MakePacket(int64_t presentationIndex,
                                             int64_t ptsUs, int64_t dtsUs,
                                             uint32_t flags, int width,
                                             int height) {
  EncodedPacket p;
  p.ptsUs = ptsUs;
  p.dtsUs = dtsUs;
  p.flags = flags;
  Payload pl;
  pl.presentationIndex = presentationIndex;
  pl.width = width > 0 ? width : kDefaultWidth;
  pl.height = height > 0 ? height : kDefaultHeight;
  p.payload.resize(sizeof(Payload));
  std::memcpy(p.payload.data(), &pl, sizeof(Payload));
  return p;
}

Status FakeDecoderBackend::Configure(const VideoTrackInfo& track) {
  track_ = track;
  configured_ = true;
  started_ = false;
  hasRef_ = false;
  out_.clear();
  VIDEO_LOGD("video.decode fake configure %dx%d", track.codedWidth,
             track.codedHeight);
  return Status::Ok();
}

Status FakeDecoderBackend::Emit(int64_t presentationIndex, int64_t ptsUs,
                                int width, int height) {
  if (width <= 0) {
    width = track_.codedWidth > 0 ? track_.codedWidth : kDefaultWidth;
  }
  if (height <= 0) {
    height = track_.codedHeight > 0 ? track_.codedHeight : kDefaultHeight;
  }
  const int yStride = AlignUp(width);
  const int uvStride = AlignUp(width);
  const size_t bytes =
      static_cast<size_t>(yStride) * static_cast<size_t>(height) +
      static_cast<size_t>(uvStride) * static_cast<size_t>((height + 1) / 2);
  DecodedRawFrame fr;
  auto st = fr.storage.Allocate(bytes);
  if (!st.ok) {
    return st;
  }
  uint8_t* y = fr.storage.data();
  uint8_t* uv = y + static_cast<size_t>(yStride) * static_cast<size_t>(height);
  const uint8_t luma = IdentityLuma(presentationIndex);
  for (int row = 0; row < height; ++row) {
    std::memset(y + static_cast<size_t>(row) * static_cast<size_t>(yStride),
                luma, static_cast<size_t>(width));
  }
  std::memset(uv, 128,
              static_cast<size_t>(uvStride) *
                  static_cast<size_t>((height + 1) / 2));
  fr.view.y.data = y;
  fr.view.y.stride = yStride;
  fr.view.uv.data = uv;
  fr.view.uv.stride = uvStride;
  fr.view.width = width;
  fr.view.height = height;
  fr.ptsUs = ptsUs;
  fr.presentationIndex = omitPresentationIndex_ ? -1 : presentationIndex;
  out_.push_back(std::move(fr));
  return Status::Ok();
}

Status FakeDecoderBackend::Submit(const EncodedPacket& packet) {
  if (!configured_) {
    return Status::Fail(kErrInvalidArgument, "fake decoder not configured");
  }
  Payload pl;
  if (!ParsePayload(packet, &pl)) {
    return Status::Fail(kErrDecodeFailed, "fake payload");
  }
  const bool key = (packet.flags & kSampleKey) != 0;
  const bool nonRef = (packet.flags & kSampleNonRef) != 0;
  if (!started_ && !key) {
    VIDEO_LOGE("video.decode fake first packet is not a keyframe");
    return Status::Fail(kErrDecodeFailed, "decoder must start at a keyframe");
  }
  if (!key && !hasRef_) {
    return Status::Fail(kErrDecodeFailed, "P/B depends on previous reference");
  }
  started_ = true;
  if (key || !nonRef) {
    hasRef_ = true;
  }
  ++submitCount_;
  return Emit(pl.presentationIndex, packet.ptsUs, pl.width, pl.height);
}

Status FakeDecoderBackend::Flush() {
  started_ = false;
  hasRef_ = false;
  out_.clear();
  ++flushCount_;
  return Status::Ok();
}

bool FakeDecoderBackend::Receive(DecodedRawFrame* out) {
  if (out == nullptr || out_.empty()) {
    return false;
  }
  *out = std::move(out_.front());
  out_.pop_front();
  return true;
}

void FakeDecoderBackend::Close() {
  configured_ = false;
  started_ = false;
  hasRef_ = false;
  out_.clear();
}

}  // namespace video
}  // namespace sherpa_onnx
