#include "codec/CodecArbiter.h"
#include "codec/CodecCaps.h"
#include "codec/CodecEvents.h"

#include <gtest/gtest.h>

#include <string>
#include <vector>

using namespace sherpa_onnx::codec;

class CodecArbiterTest : public ::testing::Test {
 protected:
  void SetUp() override {
    ResetEventsForTest();
    CodecCaps::Instance().ResetForTest();
    CodecCaps::Instance().Init(2LL * 1024 * 1024 * 1024);
    CodecArbiter::Instance().ResetForTest();
  }
  void TearDown() override {
    CodecArbiter::Instance().ResetForTest();
    ResetEventsForTest();
  }
};

TEST_F(CodecArbiterTest, FailFastWhenFull) {
  auto a = CodecArbiter::Instance().TryAcquire(ResourceClass::HwVideoEncode,
                                               "export_a");
  ASSERT_TRUE(a.ok());
  auto b = CodecArbiter::Instance().TryAcquire(ResourceClass::HwVideoEncode,
                                               "export_b");
  ASSERT_FALSE(b.ok());
  EXPECT_EQ(b.status.errorCode, "pool-full");
}

TEST_F(CodecArbiterTest, RaIIReleaseAndSlotFreedOnce) {
  std::vector<std::string> events;
  SetEventSink([&](const std::string& json) { events.push_back(json); });
  {
    auto a = CodecArbiter::Instance().TryAcquire(
        ResourceClass::HwVideoDecodeCpu, "buf_a");
    ASSERT_TRUE(a.ok());
    EXPECT_EQ(CodecArbiter::Instance().InUse(ResourceClass::HwVideoDecodeCpu),
              1);
  }
  EXPECT_EQ(CodecArbiter::Instance().InUse(ResourceClass::HwVideoDecodeCpu), 0);
  ASSERT_EQ(events.size(), 1u);
  EXPECT_NE(events[0].find("\"type\":\"slotFreed\""), std::string::npos);
  EXPECT_NE(events[0].find("hwVideoDecode"), std::string::npos);
}

TEST_F(CodecArbiterTest, ReenterSameOwnerDoesNotDoubleCount) {
  auto a = CodecArbiter::Instance().TryAcquire(ResourceClass::HwVideoDecodeCpu,
                                               "same");
  auto b = CodecArbiter::Instance().TryAcquire(ResourceClass::HwVideoDecodeCpu,
                                               "same");
  ASSERT_TRUE(a.ok());
  ASSERT_TRUE(b.ok());
  EXPECT_EQ(CodecArbiter::Instance().InUse(ResourceClass::HwVideoDecodeCpu), 1);
  a.value.Reset();
  EXPECT_EQ(CodecArbiter::Instance().InUse(ResourceClass::HwVideoDecodeCpu), 1);
  b.value.Reset();
  EXPECT_EQ(CodecArbiter::Instance().InUse(ResourceClass::HwVideoDecodeCpu), 0);
}

TEST_F(CodecArbiterTest, OverrideChangesMax) {
  ASSERT_TRUE(CodecCaps::Instance()
                  .SetOverride(ResourceClass::HwVideoEncode, 2)
                  .ok);
  auto a = CodecArbiter::Instance().TryAcquire(ResourceClass::HwVideoEncode,
                                               "e1");
  auto b = CodecArbiter::Instance().TryAcquire(ResourceClass::HwVideoEncode,
                                               "e2");
  ASSERT_TRUE(a.ok());
  ASSERT_TRUE(b.ok());
  auto c = CodecArbiter::Instance().TryAcquire(ResourceClass::HwVideoEncode,
                                               "e3");
  ASSERT_FALSE(c.ok());
}

TEST_F(CodecArbiterTest, FallbackEventDeduped) {
  std::vector<std::string> events;
  SetEventSink([&](const std::string& json) { events.push_back(json); });
  Decision d;
  d.tier = Tier::Software;
  d.origin = Origin::Bundled;
  d.provider = "stb";
  d.fellBack = true;
  d.fallbackReason = Reason::OsTooOld;
  d.fallbackCode = kErrImageHwDecoderUnavailable;
  EmitFallback("img_off", Use::Cpu, d);
  EmitFallback("img_off", Use::Cpu, d);
  ASSERT_EQ(events.size(), 1u);
  EXPECT_NE(events[0].find("\"type\":\"fallback\""), std::string::npos);
}
