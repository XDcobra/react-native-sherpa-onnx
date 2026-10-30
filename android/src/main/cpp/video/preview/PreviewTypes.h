#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {
namespace preview {

enum class PreviewState : uint8_t {
  Idle = 0,
  Preparing,
  Ready,
  Playing,
  Paused,
  Seeking,
  Buffering,
  Ended,
  Error,
  Released,
};

inline const char* PreviewStateName(PreviewState s) {
  switch (s) {
    case PreviewState::Idle:
      return "idle";
    case PreviewState::Preparing:
      return "preparing";
    case PreviewState::Ready:
      return "ready";
    case PreviewState::Playing:
      return "playing";
    case PreviewState::Paused:
      return "paused";
    case PreviewState::Seeking:
      return "seeking";
    case PreviewState::Buffering:
      return "buffering";
    case PreviewState::Ended:
      return "ended";
    case PreviewState::Error:
      return "error";
    case PreviewState::Released:
      return "released";
  }
  return "idle";
}

enum class PreviewInputKind : uint8_t {
  Prepare = 0,
  Prepared,
  Play,
  Pause,
  Seek,
  FirstFrameShown,
  DataStarved,
  DataAvailable,
  VideoEos,
  AudioEos,
  StepFrame,
  AudioFailed,
  Evicted,
  SurfaceDetached,
  SurfaceAttached,
  AppBackground,
  RendererFailed,
  BufferFinished,
  SeekLiveEdge,
  Release,
};

inline const char* PreviewInputKindName(PreviewInputKind k) {
  switch (k) {
    case PreviewInputKind::Prepare:
      return "prepare";
    case PreviewInputKind::Prepared:
      return "prepared";
    case PreviewInputKind::Play:
      return "play";
    case PreviewInputKind::Pause:
      return "pause";
    case PreviewInputKind::Seek:
      return "seek";
    case PreviewInputKind::FirstFrameShown:
      return "firstFrameShown";
    case PreviewInputKind::DataStarved:
      return "dataStarved";
    case PreviewInputKind::DataAvailable:
      return "dataAvailable";
    case PreviewInputKind::VideoEos:
      return "videoEos";
    case PreviewInputKind::AudioEos:
      return "audioEos";
    case PreviewInputKind::StepFrame:
      return "stepFrame";
    case PreviewInputKind::AudioFailed:
      return "audioFailed";
    case PreviewInputKind::Evicted:
      return "evicted";
    case PreviewInputKind::SurfaceDetached:
      return "surfaceDetached";
    case PreviewInputKind::SurfaceAttached:
      return "surfaceAttached";
    case PreviewInputKind::AppBackground:
      return "appBackground";
    case PreviewInputKind::RendererFailed:
      return "rendererFailed";
    case PreviewInputKind::BufferFinished:
      return "bufferFinished";
    case PreviewInputKind::SeekLiveEdge:
      return "seekToLiveEdge";
    case PreviewInputKind::Release:
      return "release";
  }
  return "unknown";
}

enum class PreviewEffectKind : uint8_t {
  OpenReaders = 0,
  ConfigureAudio,
  RequestDecoder,
  ReleaseDecoder,
  ClockSetRate,
  AudioStart,
  AudioPause,
  FlushAll,
  StartFeed,
  EmitFirstFrame,
  EmitSeekCompleted,
  EmitSuperseded,
  EmitEnded,
  EmitError,
  EmitAudioUnavailable,
  EmitPositionEvicted,
  EmitSeekClamped,
  EmitStateChanged,
  ResolveCreate,
  ResolvePlay,
  ResolvePause,
  ResolveSeek,
  SwitchMonotonicClock,
};

enum class AudioDecision : uint8_t {
  Track = 0,
  Absent,
  Unsupported,
  Off,
};

struct PreviewInput {
  PreviewInputKind kind = PreviewInputKind::Prepare;
  int64_t tUs = 0;
  bool hasTarget = false;
  SeekMode mode = SeekMode::Accurate;
  uint64_t gen = 0;
  int stepDir = 0;
  Status status;
  TimeRange range;
  int64_t shownPtsUs = 0;
};

struct PreviewEffect {
  PreviewEffectKind kind = PreviewEffectKind::OpenReaders;
  int64_t tUs = 0;
  double rate = 0;
  uint64_t gen = 0;
  SeekMode mode = SeekMode::Accurate;
  bool resumeAfter = false;
  std::string code;
  std::string message;
  int64_t actualUs = 0;
};

struct ControllerConfig {
  bool audioRequired = false;
  bool audioOff = false;
  bool loop = false;
  bool pauseOnBackground = true;
  bool isLive = false;
  int64_t liveTargetLatencyUs = 1'000'000;
  int64_t liveMaxLatencyUs = 3'000'000;
  int64_t startAtUs = 0;
  bool liveStartAtEdge = true;
};

struct ControllerState {
  PreviewState state = PreviewState::Idle;
  bool resumeAfter = false;
  uint64_t gen = 0;
  int64_t positionUs = 0;
  bool videoAttached = false;
  bool audioPlayable = false;
  bool audioRequired = false;
  bool audioOff = false;
  bool loop = false;
  bool pauseOnBackground = true;
  bool atLiveEdge = false;
  bool isLive = false;
  bool isRecording = false;
  int rendererFailCount = 0;
  int64_t lastRendererFailNs = 0;
  bool videoEos = false;
  bool audioEos = false;
  bool noAudio = false;
  int64_t seekableStartUs = 0;
  int64_t seekableEndUs = 0;
  int64_t liveEdgeUs = 0;
  int64_t liveTargetLatencyUs = 1'000'000;
  int64_t liveMaxLatencyUs = 3'000'000;
  AudioDecision audioDecision = AudioDecision::Track;
  int64_t pendingSeekUs = 0;
  SeekMode pendingSeekMode = SeekMode::Accurate;
};

struct HandleResult {
  ControllerState state;
  std::vector<PreviewEffect> effects;
  Status status;
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
