#include "VideoFrameAccess.h"
#include "VideoRegistry.h"
#include "core/MemoryBudget.h"
#include "decode/DecoderPool.h"
#include "synth.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;
using sherpa_onnx::video::test::FillIpp;

class RegistryTest : public ::testing::Test {
 protected:
  void TearDown() override {
    MemoryBudget::Instance().ResetUsedForTest();
    MemoryBudget::Instance().Configure(VideoRamClass::Mid);
    DecoderPool::Instance().CloseAll();
  }
};

TEST_F(RegistryTest, IdPrefixOffline) {
  auto src = std::make_unique<MemoryPacketSource>();
  FillIpp(src.get(), 15, 15, false);
  auto e = VideoRegistry::Instance().CreateOfflineFromPackets(std::move(src));
  ASSERT_NE(e, nullptr);
  EXPECT_EQ(e->id().rfind("vid_off_", 0), 0u);
  EXPECT_TRUE(VideoRegistry::Instance().Release(e->id()));
}

TEST_F(RegistryTest, ReleaseWhileLeased) {
  auto src = std::make_unique<MemoryPacketSource>();
  FillIpp(src.get(), 15, 15, false);
  auto e = VideoRegistry::Instance().CreateOfflineFromPackets(std::move(src));
  FrameRequest req;
  req.ptsUs = 0;
  auto lease = VideoFrameAccess::Acquire(e->id(), req);
  ASSERT_TRUE(lease.ok()) << lease.status.errorMessage;
  EXPECT_TRUE(lease.value.valid());
  EXPECT_TRUE(VideoRegistry::Instance().Release(e->id()));
  EXPECT_TRUE(lease.value.valid());
  EXPECT_EQ(lease.value.view().plane[0][0], FakeDecoderBackend::IdentityLuma(0));
}

TEST_F(RegistryTest, FinishedLiveAcceptedAsOfflineApi) {
  LiveVideoOptions opts;
  opts.spool.mode = SpoolRetentionMode::None;
  auto live = VideoRegistry::Instance().CreateLive(opts).value;
  ASSERT_NE(live, nullptr);
  EXPECT_EQ(live->id().rfind("vid_live_", 0), 0u);
  VideoTrackInfo t = sherpa_onnx::video::test::DefaultTrack();
  ASSERT_TRUE(live->SetCodecConfig(VideoCodec::H264, {}, t).ok);
  auto pkt = FakeDecoderBackend::MakePacket(0, 0, 0, kSampleKey);
  ASSERT_TRUE(live->AppendPacket(pkt).ok);
  ASSERT_TRUE(live->Finish().ok);
  EXPECT_EQ(live->state(), VideoBufferState::Finished);
  EXPECT_TRUE(VideoRegistry::Instance().Get(live->id()) != nullptr);
  VideoRegistry::Instance().Release(live->id());
}

TEST_F(RegistryTest, AppendAfterFinishRejected) {
  LiveVideoOptions opts;
  opts.spool.mode = SpoolRetentionMode::None;
  auto live = VideoRegistry::Instance().CreateLive(opts).value;
  VideoTrackInfo t = sherpa_onnx::video::test::DefaultTrack();
  live->SetCodecConfig(VideoCodec::H264, {}, t);
  live->AppendPacket(FakeDecoderBackend::MakePacket(0, 0, 0, kSampleKey));
  live->Finish();
  auto st = live->AppendPacket(FakeDecoderBackend::MakePacket(1, 33333, 33333, 0));
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrInvalidState);
  VideoRegistry::Instance().Release(live->id());
}
