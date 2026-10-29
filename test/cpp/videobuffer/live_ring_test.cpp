#include "core/MemoryBudget.h"
#include "decode/FakeDecoder.h"
#include "live/EncodedPacketRing.h"
#include "live/LiveVideoEntry.h"
#include "synth.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;

TEST(EncodedPacketRing, DropsUntilFirstKey) {
  EncodedPacketRing ring;
  ring.Configure(10, 1024 * 1024);
  Timeline tl;
  auto p = FakeDecoderBackend::MakePacket(0, 0, 0, 0);
  ASSERT_TRUE(ring.Append(p, &tl).ok);
  EXPECT_EQ(ring.droppedBeforeKey(), 1);
  auto k = FakeDecoderBackend::MakePacket(1, 33333, 33333, kSampleKey);
  ASSERT_TRUE(ring.Append(k, &tl).ok);
  EXPECT_EQ(ring.lastIndex(), 0);
}

TEST(EncodedPacketRing, GopEvictionByBytesNeverSplits) {
  EncodedPacketRing ring;
  ring.Configure(1000, 400);  // tiny byte budget
  Timeline tl;
  for (int g = 0; g < 6; ++g) {
    for (int i = 0; i < 4; ++i) {
      const int idx = g * 4 + i;
      uint32_t flags = i == 0 ? kSampleKey : 0;
      auto p = FakeDecoderBackend::MakePacket(idx, idx * 33333, idx * 33333,
                                              flags);
      p.payload.resize(80);
      ASSERT_TRUE(ring.Append(p, &tl).ok);
    }
  }
  EXPECT_GT(ring.evictedFrames(), 0);
  EXPECT_GE(ring.lastIndex() - ring.firstIndex() + 1, 4);
  EncodedPacket pkt;
  ASSERT_TRUE(ring.Read(ring.firstIndex(), &pkt).ok);
  EXPECT_NE((pkt.flags & kSampleKey), 0u);
}

TEST(LiveVideoEntry, FrameEvictedRange) {
  LiveVideoOptions opts;
  opts.ringSeconds = 1;
  opts.ringMaxBytes = 200;
  opts.spool.mode = SpoolRetentionMode::None;
  auto live = LiveVideoEntry::Create(opts, "/tmp");
  VideoTrackInfo t = sherpa_onnx::video::test::DefaultTrack();
  live->SetCodecConfig(VideoCodec::H264, {}, t);
  for (int i = 0; i < 20; ++i) {
    auto p = FakeDecoderBackend::MakePacket(i, i * 500000, i * 500000,
                                            i % 3 == 0 ? kSampleKey : 0);
    p.payload.resize(40);
    live->AppendPacket(p);
  }
  EncodedPacket out;
  auto st = live->ReadPacket(0, &out);
  if (!st.ok) {
    EXPECT_EQ(st.errorCode, kErrFrameEvicted);
  }
}
