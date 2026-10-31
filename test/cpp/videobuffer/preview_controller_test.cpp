#include "preview/PlaybackController.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;
using namespace sherpa_onnx::video::preview;

namespace {

bool Has(const HandleResult& r, PreviewEffectKind k) {
  for (const auto& e : r.effects) {
    if (e.kind == k) return true;
  }
  return false;
}

ControllerState ReadyPaused() {
  ControllerState s;
  s.state = PreviewState::Paused;
  s.videoAttached = true;
  s.seekableEndUs = 5'000'000;
  return s;
}

ControllerState Playing() {
  ControllerState s;
  s.state = PreviewState::Playing;
  s.videoAttached = true;
  s.audioPlayable = true;
  s.seekableEndUs = 5'000'000;
  return s;
}

}  // namespace

TEST(PreviewController, PrepareToReady) {
  ControllerState s;
  PreviewInput in;
  in.kind = PreviewInputKind::Prepare;
  auto r = PlaybackController::Handle(s, in, 0);
  ASSERT_TRUE(r.status.ok);
  EXPECT_EQ(r.state.state, PreviewState::Preparing);
  EXPECT_TRUE(Has(r, PreviewEffectKind::OpenReaders));
  in.kind = PreviewInputKind::Prepared;
  r = PlaybackController::Handle(r.state, in, 0);
  EXPECT_EQ(r.state.state, PreviewState::Ready);
  EXPECT_TRUE(Has(r, PreviewEffectKind::ResolveCreate));
}

TEST(PreviewController, PlayPause) {
  ControllerState s;
  s.state = PreviewState::Ready;
  PreviewInput in;
  in.kind = PreviewInputKind::Play;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_EQ(r.state.state, PreviewState::Playing);
  EXPECT_TRUE(Has(r, PreviewEffectKind::AudioStart));
  in.kind = PreviewInputKind::Pause;
  r = PlaybackController::Handle(r.state, in, 1000);
  EXPECT_EQ(r.state.state, PreviewState::Paused);
  EXPECT_FALSE(r.state.atLiveEdge);
}

TEST(PreviewController, SeekCoalesce) {
  auto s = Playing();
  PreviewInput in;
  in.kind = PreviewInputKind::Seek;
  in.tUs = 1'000'000;
  auto r1 = PlaybackController::Handle(s, in, 0);
  EXPECT_EQ(r1.state.state, PreviewState::Seeking);
  in.tUs = 2'000'000;
  auto r2 = PlaybackController::Handle(r1.state, in, 0);
  EXPECT_TRUE(Has(r2, PreviewEffectKind::EmitSuperseded));
  in.tUs = 3'000'000;
  auto r3 = PlaybackController::Handle(r2.state, in, 0);
  EXPECT_TRUE(Has(r3, PreviewEffectKind::EmitSuperseded));
  PreviewInput shown;
  shown.kind = PreviewInputKind::FirstFrameShown;
  shown.gen = r3.state.gen;
  shown.shownPtsUs = 3'000'000;
  auto r4 = PlaybackController::Handle(r3.state, shown, 0);
  EXPECT_EQ(r4.state.state, PreviewState::Playing);
  EXPECT_TRUE(Has(r4, PreviewEffectKind::EmitSeekCompleted));
}

TEST(PreviewController, StaleFirstFrameDropped) {
  auto s = Playing();
  PreviewInput in;
  in.kind = PreviewInputKind::Seek;
  in.tUs = 1000;
  auto r = PlaybackController::Handle(s, in, 0);
  PreviewInput shown;
  shown.kind = PreviewInputKind::FirstFrameShown;
  shown.gen = r.state.gen - 1;
  shown.shownPtsUs = 1000;
  auto stale = PlaybackController::Handle(r.state, shown, 0);
  EXPECT_EQ(stale.state.state, PreviewState::Seeking);
  EXPECT_TRUE(stale.effects.empty());
}

TEST(PreviewController, EndedPlayRestarts) {
  ControllerState s;
  s.state = PreviewState::Ended;
  s.seekableEndUs = 4'000'000;
  PreviewInput in;
  in.kind = PreviewInputKind::Play;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
  EXPECT_TRUE(r.state.resumeAfter);
}

TEST(PreviewController, LoopOnEos) {
  auto s = Playing();
  s.loop = true;
  s.positionUs = 7'000'000;
  PreviewInput in;
  in.kind = PreviewInputKind::VideoEos;
  auto r = PlaybackController::Handle(s, in, 7'000'000);
  in.kind = PreviewInputKind::AudioEos;
  r = PlaybackController::Handle(r.state, in, 7'000'000);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
  EXPECT_TRUE(r.state.resumeAfter);
  EXPECT_EQ(r.state.positionUs, 0);
  EXPECT_FALSE(r.state.videoEos);
  EXPECT_FALSE(r.state.audioEos);
}

TEST(PreviewController, FirstFrameShownClearsStaleEos) {
  auto s = Playing();
  s.loop = true;
  PreviewInput in;
  in.kind = PreviewInputKind::Seek;
  in.tUs = 0;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
  in.kind = PreviewInputKind::VideoEos;
  r = PlaybackController::Handle(r.state, in, 0);
  in.kind = PreviewInputKind::AudioEos;
  r = PlaybackController::Handle(r.state, in, 0);
  EXPECT_TRUE(r.state.videoEos);
  EXPECT_TRUE(r.state.audioEos);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
  PreviewInput shown;
  shown.kind = PreviewInputKind::FirstFrameShown;
  shown.gen = r.state.gen;
  shown.shownPtsUs = 0;
  r = PlaybackController::Handle(r.state, shown, 0);
  EXPECT_EQ(r.state.state, PreviewState::Playing);
  EXPECT_FALSE(r.state.videoEos);
  EXPECT_FALSE(r.state.audioEos);
}

TEST(PreviewController, EosEnds) {
  auto s = Playing();
  s.noAudio = true;
  PreviewInput in;
  in.kind = PreviewInputKind::VideoEos;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_EQ(r.state.state, PreviewState::Ended);
  EXPECT_TRUE(Has(r, PreviewEffectKind::EmitEnded));
}

TEST(PreviewController, StepWhilePlayingSeeksPaused) {
  auto s = Playing();
  PreviewInput in;
  in.kind = PreviewInputKind::StepFrame;
  in.stepDir = 1;
  in.tUs = 33333;
  in.hasTarget = true;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_TRUE(r.status.ok);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
  EXPECT_FALSE(r.state.resumeAfter);
  EXPECT_EQ(r.state.pendingSeekUs, 33333);
}

TEST(PreviewController, PlayWhileSeekingSetsResume) {
  auto s = Playing();
  PreviewInput in;
  in.kind = PreviewInputKind::Seek;
  in.tUs = 1'000'000;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
  in.kind = PreviewInputKind::Play;
  r = PlaybackController::Handle(r.state, in, 0);
  EXPECT_TRUE(r.status.ok);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
  EXPECT_TRUE(r.state.resumeAfter);
  EXPECT_TRUE(Has(r, PreviewEffectKind::ResolvePlay));
}

TEST(PreviewController, PauseWhileSeekingClearsResume) {
  auto s = Playing();
  PreviewInput in;
  in.kind = PreviewInputKind::Seek;
  in.tUs = 1'000'000;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_TRUE(r.state.resumeAfter);
  in.kind = PreviewInputKind::Pause;
  r = PlaybackController::Handle(r.state, in, 0);
  EXPECT_TRUE(r.status.ok);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
  EXPECT_FALSE(r.state.resumeAfter);
  EXPECT_TRUE(Has(r, PreviewEffectKind::ResolvePause));
}

TEST(PreviewController, StepWhilePaused) {
  auto s = ReadyPaused();
  PreviewInput in;
  in.kind = PreviewInputKind::StepFrame;
  in.stepDir = 1;
  in.tUs = 33333;
  in.hasTarget = true;
  auto r = PlaybackController::Handle(s, in, 1000);
  EXPECT_TRUE(r.status.ok);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
  EXPECT_FALSE(r.state.resumeAfter);
  EXPECT_EQ(r.state.pendingSeekUs, 33333);
}

TEST(PreviewController, StepWhileSeekingSupersedes) {
  auto s = ReadyPaused();
  PreviewInput in;
  in.kind = PreviewInputKind::StepFrame;
  in.stepDir = 1;
  in.tUs = 33333;
  in.hasTarget = true;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
  in.tUs = 66666;
  auto r2 = PlaybackController::Handle(r.state, in, 33333);
  EXPECT_TRUE(r2.status.ok);
  EXPECT_EQ(r2.state.state, PreviewState::Seeking);
  EXPECT_TRUE(Has(r2, PreviewEffectKind::EmitSuperseded));
  EXPECT_EQ(r2.state.pendingSeekUs, 66666);
  EXPECT_FALSE(r2.state.resumeAfter);
}

TEST(PreviewController, ReleaseIdempotent) {
  ControllerState s;
  s.state = PreviewState::Ready;
  PreviewInput in;
  in.kind = PreviewInputKind::Release;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_EQ(r.state.state, PreviewState::Released);
  r = PlaybackController::Handle(r.state, in, 0);
  EXPECT_TRUE(r.status.ok);
  EXPECT_EQ(r.state.state, PreviewState::Released);
  in.kind = PreviewInputKind::Play;
  r = PlaybackController::Handle(r.state, in, 0);
  EXPECT_EQ(r.status.errorCode, kErrPreviewReleased);
}

TEST(PreviewController, RendererFailRetryThenError) {
  auto s = Playing();
  PreviewInput in;
  in.kind = PreviewInputKind::RendererFailed;
  auto r = PlaybackController::Handle(s, in, 0, 1'000'000'000);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
  in.kind = PreviewInputKind::RendererFailed;
  r = PlaybackController::Handle(r.state, in, 0, 1'100'000'000);
  EXPECT_EQ(r.state.state, PreviewState::Error);
  EXPECT_TRUE(Has(r, PreviewEffectKind::EmitError));
}

TEST(PreviewController, DetachAttachWhilePlaying) {
  auto s = Playing();
  PreviewInput in;
  in.kind = PreviewInputKind::SurfaceDetached;
  auto r = PlaybackController::Handle(s, in, 2'000'000);
  EXPECT_FALSE(r.state.videoAttached);
  EXPECT_EQ(r.state.state, PreviewState::Playing);
  in.kind = PreviewInputKind::SurfaceAttached;
  r = PlaybackController::Handle(r.state, in, 2'000'000);
  EXPECT_TRUE(Has(r, PreviewEffectKind::RequestDecoder));
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
}

TEST(PreviewController, AudioFailedHandsOver) {
  auto s = Playing();
  PreviewInput in;
  in.kind = PreviewInputKind::AudioFailed;
  in.status = Status::Fail(kErrPreviewAudioOutputFailed, "track");
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_EQ(r.state.state, PreviewState::Playing);
  EXPECT_TRUE(Has(r, PreviewEffectKind::SwitchMonotonicClock));
  EXPECT_TRUE(Has(r, PreviewEffectKind::EmitAudioUnavailable));
}

TEST(PreviewController, BufferingRoundtrip) {
  auto s = Playing();
  PreviewInput in;
  in.kind = PreviewInputKind::DataStarved;
  auto r = PlaybackController::Handle(s, in, 5000);
  EXPECT_EQ(r.state.state, PreviewState::Buffering);
  in.kind = PreviewInputKind::DataAvailable;
  r = PlaybackController::Handle(r.state, in, 5000);
  EXPECT_EQ(r.state.state, PreviewState::Playing);
}

TEST(PreviewController, SeekLiveEdgeOnOfflineIllegal) {
  auto s = Playing();
  s.isLive = false;
  PreviewInput in;
  in.kind = PreviewInputKind::SeekLiveEdge;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_EQ(r.status.errorCode, kErrPreviewInvalidState);
}
