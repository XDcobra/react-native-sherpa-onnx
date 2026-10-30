#include "decode/DecoderPool.h"
#include "encode/EncoderBackend.h"
#include "encode/FakeEncoder.h"
#include "synth.h"

#include <memory>
#include <vector>

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;

namespace {

RawFrame MakeNv12(int w, int h, int64_t ptsUs) {
  static thread_local std::vector<uint8_t> buf;
  buf.assign(static_cast<size_t>(w * h + w * ((h + 1) / 2)), 0x80);
  RawFrame f;
  f.ptsUs = ptsUs;
  f.nv12.width = w;
  f.nv12.height = h;
  f.nv12.y.data = buf.data();
  f.nv12.y.stride = w;
  f.nv12.uv.data = buf.data() + w * h;
  f.nv12.uv.stride = w;
  return f;
}

}  // namespace

class EncoderTest : public ::testing::Test {
 protected:
  void TearDown() override { ResetEncoderFactoryForTest(); }
};

TEST_F(EncoderTest, FakeEncoderEmitsPacketsAndConfig) {
  FakeEncoder enc;
  VideoTrackInfo t = test::DefaultTrack();
  ASSERT_TRUE(enc.Configure(t, 2'000'000).ok);
  EXPECT_FALSE(enc.CodecConfig().empty());
  std::vector<EncodedPacket> out;
  ASSERT_TRUE(enc.Encode(MakeNv12(t.codedWidth, t.codedHeight, 0), &out).ok);
  ASSERT_EQ(out.size(), 1u);
  EXPECT_EQ(out[0].ptsUs, 0);
  EXPECT_NE(out[0].flags & kSampleKey, 0u);
  out.clear();
  ASSERT_TRUE(enc.Encode(MakeNv12(t.codedWidth, t.codedHeight, 33333), &out).ok);
  ASSERT_EQ(out.size(), 1u);
  EXPECT_EQ(out[0].ptsUs, 33333);
  ASSERT_TRUE(enc.Flush(&out).ok);
  EXPECT_EQ(enc.encodeCount(), 2);
  EXPECT_EQ(enc.flushCount(), 1);
  enc.Close();
}

TEST_F(EncoderTest, FactoryDefaultIsFakeEncoder) {
  ResetEncoderFactoryForTest();
  auto enc = GetEncoderFactory()();
  ASSERT_NE(enc, nullptr);
  VideoTrackInfo t = test::DefaultTrack();
  ASSERT_TRUE(enc->Configure(t, 1'000'000).ok);
  enc->Close();
}

TEST_F(EncoderTest, RegisterEncoderFactoryOverridesDefault) {
  int n = 0;
  RegisterEncoderFactory([&n]() {
    ++n;
    return std::unique_ptr<EncoderBackend>(new FakeEncoder());
  });
  auto enc = GetEncoderFactory()();
  EXPECT_EQ(n, 1);
  ASSERT_NE(enc, nullptr);
  enc->Close();
}
