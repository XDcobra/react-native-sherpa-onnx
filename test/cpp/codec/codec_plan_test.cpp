#include "codec/CodecCatalog.h"
#include "codec/CodecPolicy.h"
#include "codec/CodecRuntime.h"
#include "codec/CodecTypes.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::codec;

namespace {

Provider Make(const char* name, Tier tier, Origin origin, const char* codec,
              int maxW, int maxH, bool available = true,
              Reason unavail = Reason::None, int rank = 0) {
  Provider p;
  p.media = Media::Video;
  p.dir = Direction::Decode;
  p.codec = codec;
  p.tier = tier;
  p.origin = origin;
  p.name = name;
  p.caps.maxW = maxW;
  p.caps.maxH = maxH;
  p.caps.measuredFps1080Low = kDefaultMeasuredFps1080Low;
  p.available = available;
  p.unavailableReason = unavail;
  p.rank = rank;
  return p;
}

Request Req(Policy policy, const char* codec, int w, int h, Use use = Use::Cpu) {
  Request r;
  r.media = Media::Video;
  r.dir = Direction::Decode;
  r.use = use;
  r.stream.codec = codec;
  r.stream.width = w;
  r.stream.height = h;
  r.stream.fps = 30;
  r.policy = policy;
  r.ownerKey = "vid_off_test";
  return r;
}

std::vector<std::string> StepNames(const Plan& p) {
  std::vector<std::string> n;
  for (const auto& s : p.steps) n.push_back(s.provider->name);
  return n;
}

}  // namespace

class CodecPlanTest : public ::testing::Test {
 protected:
  void SetUp() override {
    CodecRuntime::Instance().ResetForTest();
    catalog_.Register(Make("c2.mtk.avc.decoder", Tier::Hardware, Origin::Platform,
                           "h264", 1920, 1088, true, Reason::None, 0));
    catalog_.Register(Make("c2.android.avc.decoder", Tier::Software,
                           Origin::Platform, "h264", 1920, 1088, true,
                           Reason::None, 0));
    catalog_.Register(Make("ffmpeg.h264", Tier::Software, Origin::Bundled,
                           "h264", 7680, 4320, true, Reason::None, 0));
    catalog_.Register(Make("c2.android.hevc.decoder", Tier::Software,
                           Origin::Platform, "hevc", 1920, 1088));
    catalog_.Register(Make("ffmpeg.hevc", Tier::Software, Origin::Bundled,
                           "hevc", 7680, 4320, false, Reason::Disabled));
  }
  void TearDown() override { CodecRuntime::Instance().ResetForTest(); }
  CodecCatalog catalog_;
};

TEST_F(CodecPlanTest, HardwareOnlyUsesHw) {
  auto plan = MakePlan(Req(Policy::Hardware, "h264", 1920, 1080), catalog_);
  ASSERT_EQ(plan.steps.size(), 1u);
  EXPECT_EQ(plan.steps[0].provider->name, "c2.mtk.avc.decoder");
}

TEST_F(CodecPlanTest, SoftwareOrdersPlatformThenBundled) {
  auto plan = MakePlan(Req(Policy::Software, "h264", 1920, 1080), catalog_);
  ASSERT_EQ(StepNames(plan),
            (std::vector<std::string>{"c2.android.avc.decoder", "ffmpeg.h264"}));
}

TEST_F(CodecPlanTest, PreferHardwareIsHwThenSw) {
  auto plan =
      MakePlan(Req(Policy::PreferHardware, "h264", 1920, 1080), catalog_);
  ASSERT_EQ(StepNames(plan),
            (std::vector<std::string>{"c2.mtk.avc.decoder",
                                      "c2.android.avc.decoder", "ffmpeg.h264"}));
}

TEST_F(CodecPlanTest, CapsSkipUnsupportedStream) {
  auto plan = MakePlan(Req(Policy::Software, "h264", 3840, 2160), catalog_);
  ASSERT_EQ(StepNames(plan), (std::vector<std::string>{"ffmpeg.h264"}));
  ASSERT_FALSE(plan.skipped.empty());
  EXPECT_EQ(plan.skipped[0].provider, "c2.android.avc.decoder");
  EXPECT_EQ(plan.skipped[0].reason, Reason::UnsupportedStream);
}

TEST_F(CodecPlanTest, DisabledProviderSkipped) {
  auto plan = MakePlan(Req(Policy::Software, "hevc", 3840, 2160), catalog_);
  ASSERT_TRUE(plan.steps.empty());
  bool sawDisabled = false;
  for (const auto& s : plan.skipped) {
    if (s.provider == "ffmpeg.hevc") {
      EXPECT_EQ(s.reason, Reason::Disabled);
      sawDisabled = true;
    }
    if (s.provider == "c2.android.hevc.decoder") {
      EXPECT_EQ(s.reason, Reason::UnsupportedStream);
    }
  }
  EXPECT_TRUE(sawDisabled);
}

TEST_F(CodecPlanTest, DisplaySwTooSlowAt4k) {
  auto plan =
      MakePlan(Req(Policy::Software, "h264", 3840, 2160, Use::Display), catalog_);
  bool sawSlow = false;
  for (const auto& s : plan.skipped) {
    if (s.reason == Reason::SwTooSlow) sawSlow = true;
  }
  EXPECT_TRUE(sawSlow);
}

TEST_F(CodecPlanTest, DisplaySwAllowedAt1080p30) {
  auto plan =
      MakePlan(Req(Policy::Software, "h264", 1920, 1080, Use::Display), catalog_);
  ASSERT_FALSE(plan.steps.empty());
  EXPECT_EQ(plan.steps[0].provider->name, "c2.android.avc.decoder");
}

TEST_F(CodecPlanTest, Ios16SoftwareUnavailable) {
  CodecCatalog ios;
  Provider hw = Make("vt.hw", Tier::Unknown, Origin::Platform, "h264", 4096,
                     2160);
  Provider sw = Make("vt.sw", Tier::Software, Origin::Platform, "h264", 4096,
                     2160, false, Reason::OsTooOld);
  ios.Register(hw);
  ios.Register(sw);
  auto plan = MakePlan(Req(Policy::Software, "h264", 1920, 1080), ios);
  ASSERT_TRUE(plan.steps.empty());
  ASSERT_FALSE(plan.skipped.empty());
  EXPECT_EQ(plan.skipped.back().reason, Reason::OsTooOld);
}

TEST_F(CodecPlanTest, Ios174BothTiers) {
  CodecCatalog ios;
  ios.Register(Make("vt.hw", Tier::Hardware, Origin::Platform, "h264", 4096, 2160));
  ios.Register(Make("vt.sw", Tier::Software, Origin::Platform, "h264", 4096, 2160));
  auto plan =
      MakePlan(Req(Policy::PreferHardware, "h264", 1920, 1080), ios);
  ASSERT_EQ(StepNames(plan),
            (std::vector<std::string>{"vt.hw", "vt.sw"}));
}

TEST_F(CodecPlanTest, ResolveCascade) {
  EXPECT_EQ(ResolvePolicy(Policy::Software, Policy::Hardware,
                          Policy::PreferHardware),
            Policy::Software);
  EXPECT_EQ(ResolvePolicy(std::nullopt, Policy::Hardware,
                          Policy::PreferHardware),
            Policy::Hardware);
  EXPECT_EQ(ResolvePolicy(std::nullopt, std::nullopt, Policy::Software),
            Policy::Software);
  EXPECT_EQ(ResolvePolicy(std::nullopt, std::nullopt, std::nullopt),
            Policy::PreferHardware);
}

TEST_F(CodecPlanTest, ImageHeicApi26NoSteps) {
  CodecCatalog img;
  Provider plat;
  plat.media = Media::Image;
  plat.dir = Direction::Decode;
  plat.codec = "heic";
  plat.tier = Tier::Hardware;
  plat.origin = Origin::Platform;
  plat.name = "AImageDecoder";
  plat.available = false;
  plat.unavailableReason = Reason::OsTooOld;
  img.Register(plat);
  Request r;
  r.media = Media::Image;
  r.dir = Direction::Decode;
  r.use = Use::Cpu;
  r.stream.codec = "heic";
  r.policy = Policy::PreferHardware;
  r.ownerKey = "img_off";
  auto plan = MakePlan(r, img);
  EXPECT_TRUE(plan.steps.empty());
  ASSERT_FALSE(plan.skipped.empty());
  EXPECT_EQ(plan.skipped[0].reason, Reason::OsTooOld);
}
