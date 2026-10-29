#include "VideoFrameAccess.h"
#include "VideoImageBridge.h"
#include "VideoRegistry.h"
#include "core/MemoryBudget.h"
#include "decode/DecoderPool.h"
#include "image/ImageRegistry.h"
#include "synth.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;
using sherpa_onnx::video::test::FillIpp;

class IteratorTest : public ::testing::Test {
 protected:
  void TearDown() override {
    MemoryBudget::Instance().ResetUsedForTest();
    DecoderPool::Instance().CloseAll();
  }
};

TEST_F(IteratorTest, OneSeekPerRangeAll) {
  auto src = std::make_unique<MemoryPacketSource>();
  FillIpp(src.get(), 15, 15, false);
  auto e = VideoRegistry::Instance().CreateOfflineFromPackets(std::move(src));
  IterateRequest req;
  req.sampling = SamplingMode::All;
  req.endUs = -1;
  auto it = VideoFrameAccess::Iterate(e->id(), req);
  ASSERT_TRUE(it.ok());
  int n = 0;
  while (!it.value.done()) {
    auto lease = it.value.Next();
    ASSERT_TRUE(lease.ok()) << lease.status.errorMessage;
    ++n;
  }
  EXPECT_EQ(n, 15);
  EXPECT_EQ(it.value.seekCount(), 1);
  VideoRegistry::Instance().Release(e->id());
}

TEST_F(IteratorTest, KeyframesSampling) {
  auto src = std::make_unique<MemoryPacketSource>();
  FillIpp(src.get(), 45, 15, false);
  auto e = VideoRegistry::Instance().CreateOfflineFromPackets(std::move(src));
  IterateRequest req;
  req.sampling = SamplingMode::Keyframes;
  auto it = VideoFrameAccess::Iterate(e->id(), req);
  ASSERT_TRUE(it.ok());
  int n = 0;
  while (!it.value.done()) {
    ASSERT_TRUE(it.value.Next().ok());
    ++n;
  }
  EXPECT_EQ(n, 3);
  VideoRegistry::Instance().Release(e->id());
}

TEST_F(IteratorTest, UniformAndFps) {
  auto src = std::make_unique<MemoryPacketSource>();
  FillIpp(src.get(), 30, 15, false);
  auto e = VideoRegistry::Instance().CreateOfflineFromPackets(std::move(src));
  IterateRequest req;
  req.sampling = SamplingMode::Uniform;
  req.uniformCount = 4;
  auto sel = SelectPresentationIndices(
      *VideoRegistry::Instance().Get(e->id())->timeline(), req);
  EXPECT_EQ(sel.size(), 4u);
  req.sampling = SamplingMode::Fps;
  req.fps = 2;
  sel = SelectPresentationIndices(
      *VideoRegistry::Instance().Get(e->id())->timeline(), req);
  EXPECT_GE(sel.size(), 2u);
  VideoRegistry::Instance().Release(e->id());
}

TEST_F(IteratorTest, ImageBridgeCopiesSourcePts) {
  auto src = std::make_unique<MemoryPacketSource>();
  FillIpp(src.get(), 6, 3, false);
  auto e = VideoRegistry::Instance().CreateOfflineFromPackets(std::move(src));
  ImageBridgeRequest req;
  req.sampling = SamplingMode::All;
  auto r = VideoImageBridge::CreateImageBuffer(e->id(), req);
  ASSERT_TRUE(r.status.ok) << r.status.errorMessage;
  EXPECT_EQ(r.frameCount, 6);
  sherpa_onnx::image::ImageFrameInfo info;
  ASSERT_TRUE(sherpa_onnx::image::ImageRegistry::Instance().GetFrameInfo(
      r.imageBufferId, 0, info));
  EXPECT_EQ(info.sourceVideoBufferId, e->id());
  EXPECT_GE(info.sourcePtsUs, 0);
  sherpa_onnx::image::ImageRegistry::Instance().Release(r.imageBufferId);
  VideoRegistry::Instance().Release(e->id());
}
