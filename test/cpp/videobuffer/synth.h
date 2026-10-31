#pragma once

#include "decode/FakeDecoder.h"
#include "decode/MemoryPacketSource.h"

#include <vector>

namespace sherpa_onnx {
namespace video {
namespace test {

inline VideoTrackInfo DefaultTrack() {
  VideoTrackInfo t;
  t.codec = VideoCodec::H264;
  t.codedWidth = FakeDecoderBackend::kDefaultWidth;
  t.codedHeight = FakeDecoderBackend::kDefaultHeight;
  t.displayWidth = t.codedWidth;
  t.displayHeight = t.codedHeight;
  t.nominalFps = {30, 1};
  return t;
}

/** CFR, dts==pts. Keys every gop. Odd non-keys marked NonRef when requested. */
inline void FillIpp(MemoryPacketSource* src, int frames, int gop,
                    bool oddNonRef) {
  src->SetTrack(DefaultTrack());
  std::vector<SampleEntry> samples;
  std::vector<EncodedPacket> packets;
  samples.reserve(static_cast<size_t>(frames));
  packets.resize(static_cast<size_t>(frames));
  for (int i = 0; i < frames; ++i) {
    SampleEntry s;
    s.ptsUs = static_cast<int64_t>(i) * 33333;
    s.dtsUs = s.ptsUs;
    if (i % gop == 0) {
      s.flags = kSampleKey;
    } else if (oddNonRef && (i % 2 == 1)) {
      s.flags = kSampleNonRef;
    }
    samples.push_back(s);
    packets[static_cast<size_t>(i)] = FakeDecoderBackend::MakePacket(
        i, s.ptsUs, s.dtsUs, s.flags);
  }
  src->mutableTimeline()->AssignImmutable(std::move(samples));
  src->SetPackets(std::move(packets));
}

}  // namespace test
}  // namespace video
}  // namespace sherpa_onnx
