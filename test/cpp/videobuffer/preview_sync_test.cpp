#include "preview/FrameScheduler.h"
#include "preview/PlaybackClock.h"
#include "preview/PlaybackController.h"
#include "preview/PcmRing.h"
#include "preview/Renderers.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;
using namespace sherpa_onnx::video::preview;

namespace {

class FakeVideo : public IVideoRenderer {
 public:
  Status Configure(const VideoTrackInfo&) override { return Status::Ok(); }
  Status Submit(const EncodedPacket& pkt, bool display, uint64_t gen) override {
    (void)gen;
    if (display) {
      lastPts_ = pkt.ptsUs;
      ++stats_.rendered;
      if (onFirstFrameShown) onFirstFrameShown(gen, pkt.ptsUs);
    }
    return Status::Ok();
  }
  bool ReadyForMore() const override { return true; }
  void Flush(uint64_t) override {}
  void SignalEos(uint64_t gen) override {
    if (onEos) onEos(gen);
  }
  VideoRenderStats stats() const override { return stats_; }
  void Close() override {}
  int64_t lastPts_ = -1;
  VideoRenderStats stats_;
};

class FakeAudio : public IAudioRenderer {
 public:
  Status Open(int, int) override { return Status::Ok(); }
  void Start() override { playing_ = true; }
  void Pause() override { playing_ = false; }
  void Flush(uint64_t) override { queued_ = 0; }
  void SetVolume(float v) override { vol_ = v; }
  int64_t queuedFrames() const override { return queued_; }
  int Write(const float*, int frames, int64_t) override {
    queued_ += frames;
    return frames;
  }
  void Close() override { playing_ = false; }
  bool playing_ = false;
  float vol_ = 1;
  int64_t queued_ = 0;
};

}  // namespace

TEST(PreviewSync, SchedulerWithinOneFrame) {
  const int64_t frameDur = 33333;
  auto r = FrameScheduler::Decide(33333, 30000, 0, 16666666, frameDur);
  EXPECT_NE(r.decision, FrameDecision::Drop);
}

TEST(PreviewSync, MuteKeepsClock) {
  MonotonicClock c;
  c.SetNowNsForTest(0);
  c.SetRate(1, 0);
  c.SetNowNsForTest(50'000'000);
  const int64_t a = c.NowMediaUs();
  FakeAudio audio;
  audio.SetVolume(0);
  c.SetNowNsForTest(100'000'000);
  const int64_t b = c.NowMediaUs();
  EXPECT_GT(b, a);
}

TEST(PreviewSync, AudioFailureNoJump) {
  ControllerState s;
  s.state = PreviewState::Playing;
  s.audioPlayable = true;
  PreviewInput in;
  in.kind = PreviewInputKind::AudioFailed;
  auto r = PlaybackController::Handle(s, in, 123456);
  EXPECT_EQ(r.state.state, PreviewState::Playing);
  bool switched = false;
  for (const auto& e : r.effects) {
    if (e.kind == PreviewEffectKind::SwitchMonotonicClock) switched = true;
  }
  EXPECT_TRUE(switched);
}

TEST(PreviewSync, PadOnLateAudioTrimOverlap) {
  PcmRing ring;
  ring.Configure(1000, 1, 200);
  float a[10] = {};
  ASSERT_TRUE(ring.Write(a, 10, 0));
  float b[10] = {};
  int64_t pts = 0;
  ring.Read(b, 5, &pts);
  EXPECT_EQ(pts, 0);
}
