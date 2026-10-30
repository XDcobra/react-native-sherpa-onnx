#include "preview/PlaybackController.h"

#include <gtest/gtest.h>

using namespace sherpa_onnx::video;
using namespace sherpa_onnx::video::preview;

TEST(PreviewLive, StartAtEdgeClampsAfterEdge) {
  ControllerState s;
  s.state = PreviewState::Ready;
  s.isLive = true;
  s.isRecording = true;
  s.liveEdgeUs = 5'000'000;
  s.liveTargetLatencyUs = 1'000'000;
  s.seekableStartUs = 0;
  PreviewInput in;
  in.kind = PreviewInputKind::Seek;
  in.tUs = 5'000'000;
  auto r = PlaybackController::Handle(s, in, 0);
  ASSERT_TRUE(r.status.ok);
  bool clamped = false;
  for (const auto& e : r.effects) {
    if (e.kind == PreviewEffectKind::EmitSeekClamped) {
      clamped = true;
      EXPECT_EQ(e.message, "afterLiveEdge");
      EXPECT_EQ(e.actualUs, 4'000'000);
    }
  }
  EXPECT_TRUE(clamped);
}

TEST(PreviewLive, ClampBeforeStart) {
  ControllerState s;
  s.state = PreviewState::Paused;
  s.isLive = true;
  s.isRecording = true;
  s.seekableStartUs = 2'000'000;
  s.liveEdgeUs = 8'000'000;
  PreviewInput in;
  in.kind = PreviewInputKind::Seek;
  in.tUs = 0;
  auto r = PlaybackController::Handle(s, in, 0);
  bool clamped = false;
  for (const auto& e : r.effects) {
    if (e.kind == PreviewEffectKind::EmitSeekClamped) {
      clamped = true;
      EXPECT_EQ(e.message, "beforeStart");
    }
  }
  EXPECT_TRUE(clamped);
}

TEST(PreviewLive, BufferingThresholds) {
  ControllerState s;
  s.state = PreviewState::Playing;
  s.isLive = true;
  s.isRecording = true;
  PreviewInput in;
  in.kind = PreviewInputKind::DataStarved;
  auto r = PlaybackController::Handle(s, in, 1000);
  EXPECT_EQ(r.state.state, PreviewState::Buffering);
  in.kind = PreviewInputKind::DataAvailable;
  r = PlaybackController::Handle(r.state, in, 1000);
  EXPECT_EQ(r.state.state, PreviewState::Playing);
}

TEST(PreviewLive, EvictionWhilePaused) {
  ControllerState s;
  s.state = PreviewState::Paused;
  s.isLive = true;
  s.isRecording = true;
  s.seekableStartUs = 3'000'000;
  PreviewInput in;
  in.kind = PreviewInputKind::Evicted;
  auto r = PlaybackController::Handle(s, in, 4'000'000);
  bool evicted = false;
  for (const auto& e : r.effects) {
    if (e.kind == PreviewEffectKind::EmitPositionEvicted) {
      evicted = true;
      EXPECT_EQ(e.actualUs, 3'000'000);
    }
  }
  EXPECT_TRUE(evicted);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
}

TEST(PreviewLive, FinishSetsDuration) {
  ControllerState s;
  s.state = PreviewState::Playing;
  s.isLive = true;
  s.isRecording = true;
  s.liveEdgeUs = 9'000'000;
  PreviewInput in;
  in.kind = PreviewInputKind::BufferFinished;
  in.tUs = 9'000'000;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_FALSE(r.state.isRecording);
  EXPECT_EQ(r.state.seekableEndUs, 9'000'000);
}

TEST(PreviewLive, SeekToLiveEdge) {
  ControllerState s;
  s.state = PreviewState::Paused;
  s.isLive = true;
  s.isRecording = true;
  s.liveEdgeUs = 10'000'000;
  s.liveTargetLatencyUs = 1'000'000;
  PreviewInput in;
  in.kind = PreviewInputKind::SeekLiveEdge;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_TRUE(r.status.ok);
  EXPECT_TRUE(r.state.atLiveEdge);
  EXPECT_EQ(r.state.state, PreviewState::Seeking);
}

TEST(PreviewLive, SeekToLiveEdgeOfflineIllegal) {
  ControllerState s;
  s.state = PreviewState::Paused;
  s.isLive = false;
  PreviewInput in;
  in.kind = PreviewInputKind::SeekLiveEdge;
  auto r = PlaybackController::Handle(s, in, 0);
  EXPECT_EQ(r.status.errorCode, kErrPreviewInvalidState);
}
