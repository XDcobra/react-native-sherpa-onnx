#include "core/DecodedFrameCache.h"
#include "core/MemoryBudget.h"
#include "decode/DecodeSession.h"
#include "decode/DecoderPool.h"
#include "decode/FakeDecoder.h"
#include "synth.h"

#include <atomic>
#include <memory>

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;
using sherpa_onnx::video::test::FillIpp;

namespace {

struct SessionBundle {
  MemoryPacketSource source;
  std::shared_ptr<DecodedFrameCache> cache;
  std::shared_ptr<FakeDecoderBackend> decoder;
  std::unique_ptr<DecodeSession> session;

  SessionBundle() {
    FillIpp(&source, 45, 15, false);
    cache = std::make_shared<DecodedFrameCache>();
    decoder = std::make_shared<FakeDecoderBackend>();
    session = std::make_unique<DecodeSession>("vid_off_test", &source,
                                             &source.timeline(), cache,
                                             decoder);
  }
};

FrameRequest Acc(int64_t ptsUs) {
  FrameRequest r;
  r.ptsUs = ptsUs;
  r.mode = SeekMode::Accurate;
  r.format = VideoPixelFormat::Nv12;
  return r;
}

}  // namespace

class DecodeSessionTest : public ::testing::Test {
 protected:
  void TearDown() override {
    MemoryBudget::Instance().ResetUsedForTest();
    MemoryBudget::Instance().Configure(VideoRamClass::Mid);
    DecoderPool::Instance().CloseAll();
  }
};

TEST_F(DecodeSessionTest, FirstPacketMustBeKeyframe) {
  FakeDecoderBackend dec;
  VideoTrackInfo t = test::DefaultTrack();
  ASSERT_TRUE(dec.Configure(t).ok);
  auto p = FakeDecoderBackend::MakePacket(1, 33333, 33333, 0);
  auto st = dec.Submit(p);
  EXPECT_FALSE(st.ok);
  EXPECT_EQ(st.errorCode, kErrDecodeFailed);
}

TEST_F(DecodeSessionTest, AccurateReturnsExactPts) {
  SessionBundle b;
  auto lease = b.session->SeekAndAcquire(Acc(5 * 33333));
  ASSERT_TRUE(lease.ok()) << lease.status.errorMessage;
  EXPECT_EQ(lease.value.view().ptsUs, 5 * 33333);
  EXPECT_EQ(lease.value.view().frameIndex, 5);
  EXPECT_EQ(lease.value.view().plane[0][0], FakeDecoderBackend::IdentityLuma(5));
}

TEST_F(DecodeSessionTest, KeyframeModeDecodesOneFrame) {
  SessionBundle b;
  FrameRequest r;
  r.ptsUs = 8 * 33333;
  r.mode = SeekMode::Keyframe;
  auto lease = b.session->SeekAndAcquire(r);
  ASSERT_TRUE(lease.ok()) << lease.status.errorMessage;
  EXPECT_EQ(lease.value.view().frameIndex, 0);
  EXPECT_EQ(b.decoder->submitCount(), 1);
}

TEST_F(DecodeSessionTest, SameGopForwardDoesNotFlush) {
  SessionBundle b;
  ASSERT_TRUE(b.session->SeekAndAcquire(Acc(2 * 33333)).ok());
  const int flushes = b.decoder->flushCount();
  const int submits = b.decoder->submitCount();
  ASSERT_TRUE(b.session->SeekAndAcquire(Acc(6 * 33333)).ok());
  EXPECT_TRUE(b.session->sameGopReuse());
  EXPECT_EQ(b.decoder->flushCount(), flushes);
  EXPECT_GT(b.decoder->submitCount(), submits);
}

TEST_F(DecodeSessionTest, ReleaseMidDecodeCancelled) {
  SessionBundle b;
  std::atomic<uint64_t> gen{1};
  b.session->SetGenerationSource([&] { return gen.load(); });

  class BumpSource : public PacketSource {
   public:
    MemoryPacketSource* inner = nullptr;
    std::atomic<uint64_t>* gen = nullptr;
    const VideoTrackInfo& track() const override { return inner->track(); }
    int64_t sampleCount() const override { return inner->sampleCount(); }
    Status GetSample(int64_t i, SampleEntry* o) const override {
      return inner->GetSample(i, o);
    }
    Status ReadPacket(int64_t i, EncodedPacket* o) override {
      auto st = inner->ReadPacket(i, o);
      if (inner->readCount() >= 2 && gen) {
        gen->store(99);
      }
      return st;
    }
  } bump;
  bump.inner = &b.source;
  bump.gen = &gen;
  DecodeSession sess("vid_off_test", &bump, &b.source.timeline(), b.cache,
                     b.decoder);
  sess.SetGenerationSource([&] { return gen.load(); });
  auto lease = sess.SeekAndAcquire(Acc(8 * 33333));
  ASSERT_FALSE(lease.ok());
  EXPECT_EQ(lease.status.errorCode, kErrCancelled);
}

TEST_F(DecodeSessionTest, GopReuseDecodedCountEqualsUniqueFrames) {
  SessionBundle b;
  ASSERT_TRUE(b.session->SeekAndAcquire(Acc(4 * 33333)).ok());
  const int first = b.decoder->submitCount();
  ASSERT_TRUE(b.session->SeekAndAcquire(Acc(4 * 33333)).ok());
  EXPECT_EQ(b.decoder->submitCount(), first);
  ASSERT_TRUE(b.session->SeekAndAcquire(Acc(3 * 33333)).ok());
  EXPECT_EQ(b.decoder->submitCount(), first);
}
