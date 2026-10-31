#include "codec/CodecArbiter.h"
#include "codec/CodecCaps.h"
#include "codec/CodecCatalog.h"
#include "codec/CodecRuntime.h"
#include "codec/CodecSelector.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::codec;

namespace {

struct FakeBackend {
  std::string name;
};

Provider Hw(const char* name) {
  Provider p;
  p.media = Media::Video;
  p.dir = Direction::Decode;
  p.codec = "h264";
  p.tier = Tier::Hardware;
  p.origin = Origin::Platform;
  p.name = name;
  p.caps.maxW = 1920;
  p.caps.maxH = 1088;
  return p;
}

Provider Sw(const char* name) {
  Provider p = Hw(name);
  p.tier = Tier::Software;
  return p;
}

Request CpuReq() {
  Request r;
  r.media = Media::Video;
  r.dir = Direction::Decode;
  r.use = Use::Cpu;
  r.stream.codec = "h264";
  r.stream.width = 1920;
  r.stream.height = 1080;
  r.policy = Policy::PreferHardware;
  r.ownerKey = "owner";
  return r;
}

}  // namespace

class CodecSelectorTest : public ::testing::Test {
 protected:
  void SetUp() override {
    CodecRuntime::Instance().ResetForTest();
    CodecCaps::Instance().Init(2LL * 1024 * 1024 * 1024);
  }
  void TearDown() override { CodecRuntime::Instance().ResetForTest(); }
};

TEST_F(CodecSelectorTest, FallsBackWhenHwOpenFails) {
  CodecCatalog::Instance().Register(Hw("hw.dec"));
  CodecCatalog::Instance().Register(Sw("sw.dec"));
  auto result = Select<FakeBackend>(
      CpuReq(), CodecArbiter::Instance(),
      [](const Provider& p) -> Result<std::unique_ptr<FakeBackend>> {
        Result<std::unique_ptr<FakeBackend>> r;
        if (p.tier == Tier::Hardware) {
          r.status = Status::Fail("VIDEO_DECODER_UNAVAILABLE", "configure");
          return r;
        }
        r.value = std::make_unique<FakeBackend>();
        r.value->name = p.name;
        return r;
      });
  ASSERT_TRUE(result.ok());
  EXPECT_EQ(result.decision.provider, "sw.dec");
  EXPECT_TRUE(result.decision.fellBack);
  EXPECT_EQ(result.decision.fallbackReason, Reason::ConfigureFailed);
}

TEST_F(CodecSelectorTest, EmptyPlanSoftwareDisabled) {
  Provider p = Sw("ffmpeg.h264");
  p.available = false;
  p.unavailableReason = Reason::Disabled;
  CodecCatalog::Instance().Register(p);
  Request req = CpuReq();
  req.policy = Policy::Software;
  auto result = Select<FakeBackend>(
      req, CodecArbiter::Instance(),
      [](const Provider&) -> Result<std::unique_ptr<FakeBackend>> {
        return {};
      });
  ASSERT_FALSE(result.ok());
  EXPECT_EQ(result.status.errorCode, kErrVideoSwDecoderDisabled);
}
