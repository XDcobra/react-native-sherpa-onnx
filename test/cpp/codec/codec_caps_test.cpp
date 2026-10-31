#include "codec/CodecCaps.h"
#include "codec/CodecTypes.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::codec;

TEST(CodecCaps, ClassifyRam) {
  const int64_t gb = 1024LL * 1024LL * 1024LL;
  EXPECT_EQ(ClassifyRam(2 * gb), RamClass::Low);
  EXPECT_EQ(ClassifyRam(3 * gb), RamClass::Low);
  EXPECT_EQ(ClassifyRam(4 * gb), RamClass::Mid);
  EXPECT_EQ(ClassifyRam(6 * gb), RamClass::Mid);
  EXPECT_EQ(ClassifyRam(8 * gb), RamClass::High);
  EXPECT_EQ(ClassifyRam(16 * gb), RamClass::VeryHigh);
}

TEST(CodecCaps, TableMatchesPlan) {
  EXPECT_EQ(TableLimit(RamClass::Low, ResourceClass::HwVideoDecodeCpu), 1);
  EXPECT_EQ(TableLimit(RamClass::Low, ResourceClass::PlatformImageDecode), 1);
  EXPECT_EQ(TableLimit(RamClass::Mid, ResourceClass::PlatformImageDecode), 2);
  EXPECT_EQ(TableLimit(RamClass::High, ResourceClass::HwVideoDecodeCpu), 2);
  EXPECT_EQ(TableLimit(RamClass::High, ResourceClass::SwVideoDecode), 2);
  EXPECT_EQ(TableLimit(RamClass::VeryHigh, ResourceClass::HwVideoEncode), 2);
}

TEST(CodecCaps, InitAndHintClamp) {
  auto& caps = CodecCaps::Instance();
  caps.ResetForTest();
  caps.Init(2LL * 1024 * 1024 * 1024);
  EXPECT_EQ(caps.ramClass(), RamClass::Low);
  EXPECT_EQ(caps.Limit(ResourceClass::HwVideoDecodeCpu), 1);
  EXPECT_EQ(caps.Source(ResourceClass::HwVideoDecodeCpu), std::string("auto"));

  Provider p;
  p.media = Media::Video;
  p.dir = Direction::Decode;
  p.tier = Tier::Hardware;
  p.caps.maxInstancesHint = 15;
  caps.ApplyInstanceHints({p});
  EXPECT_EQ(caps.Limit(ResourceClass::HwVideoDecodeCpu), 1);

  Provider implausible;
  implausible.media = Media::Video;
  implausible.dir = Direction::Decode;
  implausible.tier = Tier::Hardware;
  implausible.caps.maxInstancesHint = 99;
  caps.ApplyInstanceHints({implausible});
  EXPECT_EQ(caps.Limit(ResourceClass::HwVideoDecodeCpu), 1);

  Provider zero;
  zero.media = Media::Video;
  zero.dir = Direction::Decode;
  zero.tier = Tier::Hardware;
  zero.caps.maxInstancesHint = 0;
  caps.ApplyInstanceHints({zero});
  EXPECT_EQ(caps.Limit(ResourceClass::HwVideoDecodeCpu), 1);
}

TEST(CodecCaps, OverrideClampAndSource) {
  auto& caps = CodecCaps::Instance();
  caps.ResetForTest();
  caps.Init(8LL * 1024 * 1024 * 1024);
  auto bad = caps.SetOverride(ResourceClass::HwVideoEncode, 0);
  EXPECT_FALSE(bad.ok);
  EXPECT_EQ(bad.errorCode, kErrCodecInvalidArgument);
  auto bad2 = caps.SetOverride(ResourceClass::HwVideoEncode, 5);
  EXPECT_FALSE(bad2.ok);
  ASSERT_TRUE(caps.SetOverride(ResourceClass::HwVideoEncode, 3).ok);
  EXPECT_EQ(caps.Limit(ResourceClass::HwVideoEncode), 3);
  EXPECT_EQ(caps.Source(ResourceClass::HwVideoEncode), std::string("override"));
  caps.ClearOverrides();
  EXPECT_EQ(caps.Source(ResourceClass::HwVideoEncode), std::string("auto"));
}

TEST(CodecCaps, StreamFitsAlignmentAndBlocks) {
  ProviderCaps c;
  c.maxW = 1920;
  c.maxH = 1088;
  c.widthAlign = 16;
  c.heightAlign = 16;
  c.blockW = 16;
  c.blockH = 16;
  c.maxBlocks = 8160;
  StreamCaps s;
  s.width = 1920;
  s.height = 1088;
  EXPECT_TRUE(StreamFits(c, s));
  s.width = 1921;
  EXPECT_FALSE(StreamFits(c, s));
  s.width = 1920;
  s.height = 2160;
  EXPECT_FALSE(StreamFits(c, s));
  s.width = 3840;
  s.height = 2160;
  EXPECT_FALSE(StreamFits(c, s));
}

TEST(CodecCaps, StreamFitsProfileAndBitDepth) {
  ProviderCaps c;
  c.maxBitDepth = 8;
  c.profiles = {66, 77};
  StreamCaps s;
  s.width = 640;
  s.height = 360;
  s.profile = 100;
  EXPECT_FALSE(StreamFits(c, s));
  s.profile = 66;
  s.bitDepth = 10;
  EXPECT_FALSE(StreamFits(c, s));
  s.bitDepth = 8;
  EXPECT_TRUE(StreamFits(c, s));
}

TEST(CodecCaps, SwDecodeBoundedByCores) {
  EXPECT_GE(SwDecodeThreadCap(), 1);
  EXPECT_GE(FfmpegThreadCount(), 1);
  EXPECT_LE(FfmpegThreadCount(), 4);
}
