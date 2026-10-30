#include "preview/PlaybackController.h"

#include "VideoLog.h"

#include <algorithm>

namespace sherpa_onnx {
namespace video {
namespace preview {
namespace {

PreviewEffect Eff(PreviewEffectKind k) {
  PreviewEffect e;
  e.kind = k;
  return e;
}

HandleResult Illegal(const ControllerState& s) {
  HandleResult r;
  r.state = s;
  r.status = Status::Fail(kErrPreviewInvalidState, PreviewStateName(s.state));
  return r;
}

HandleResult Ok(ControllerState s, std::vector<PreviewEffect> fx,
                PreviewState from) {
  HandleResult r;
  if (s.state != from) {
    PreviewEffect e = Eff(PreviewEffectKind::EmitStateChanged);
    e.message = PreviewStateName(from);
    e.code = PreviewStateName(s.state);
    fx.insert(fx.begin(), e);
    VIDEO_LOGI("video.preview.state %s -> %s", PreviewStateName(from),
               PreviewStateName(s.state));
  }
  r.state = std::move(s);
  r.effects = std::move(fx);
  return r;
}

bool Active(PreviewState s) {
  return s != PreviewState::Idle && s != PreviewState::Released &&
         s != PreviewState::Error;
}

int64_t ClampLive(const ControllerState& s, int64_t t, const char** reason) {
  *reason = nullptr;
  if (t < s.seekableStartUs) {
    *reason = "beforeStart";
    return s.seekableStartUs;
  }
  if (s.isRecording) {
    const int64_t edge = s.liveEdgeUs - s.liveTargetLatencyUs;
    if (t > edge) {
      *reason = "afterLiveEdge";
      return edge;
    }
  } else if (t > s.seekableEndUs && s.seekableEndUs > s.seekableStartUs) {
    *reason = "afterLiveEdge";
    return s.seekableEndUs;
  }
  return t;
}

HandleResult BeginSeek(ControllerState s, int64_t t, SeekMode mode,
                       bool resumeAfter, PreviewState from) {
  const char* reason = nullptr;
  const int64_t clamped = ClampLive(s, t, &reason);
  s.gen += 1;
  s.resumeAfter = resumeAfter;
  s.pendingSeekUs = clamped;
  s.pendingSeekMode = mode;
  s.state = PreviewState::Seeking;
  s.videoEos = false;
  s.audioEos = false;
  s.atLiveEdge = false;
  std::vector<PreviewEffect> fx;
  if (reason) {
    PreviewEffect c = Eff(PreviewEffectKind::EmitSeekClamped);
    c.tUs = t;
    c.actualUs = clamped;
    c.message = reason;
    fx.push_back(c);
  }
  PreviewEffect clk = Eff(PreviewEffectKind::ClockSetRate);
  clk.rate = 0;
  clk.tUs = s.positionUs;
  fx.push_back(clk);
  PreviewEffect flush = Eff(PreviewEffectKind::FlushAll);
  flush.gen = s.gen;
  fx.push_back(flush);
  PreviewEffect feed = Eff(PreviewEffectKind::StartFeed);
  feed.tUs = clamped;
  feed.mode = mode;
  feed.gen = s.gen;
  feed.resumeAfter = resumeAfter;
  fx.push_back(feed);
  return Ok(s, std::move(fx), from);
}

}  // namespace

HandleResult PlaybackController::Handle(const ControllerState& in,
                                        const PreviewInput& input,
                                        int64_t nowMediaUs, int64_t nowNs) {
  ControllerState s = in;
  const PreviewState from = s.state;

  if (from == PreviewState::Released &&
      input.kind != PreviewInputKind::Release) {
    HandleResult r;
    r.state = s;
    r.status = Status::Fail(kErrPreviewReleased, "released");
    return r;
  }
  if (from == PreviewState::Error && input.kind != PreviewInputKind::Release) {
    return Illegal(s);
  }

  switch (input.kind) {
    case PreviewInputKind::Prepare: {
      if (from != PreviewState::Idle) return Illegal(s);
      s.state = PreviewState::Preparing;
      std::vector<PreviewEffect> fx;
      fx.push_back(Eff(PreviewEffectKind::OpenReaders));
      fx.push_back(Eff(PreviewEffectKind::ConfigureAudio));
      if (s.videoAttached) {
        fx.push_back(Eff(PreviewEffectKind::RequestDecoder));
      }
      return Ok(s, std::move(fx), from);
    }
    case PreviewInputKind::Prepared: {
      if (from != PreviewState::Preparing) return Illegal(s);
      s.state = PreviewState::Ready;
      std::vector<PreviewEffect> fx;
      if (s.videoAttached) {
        fx.push_back(Eff(PreviewEffectKind::EmitFirstFrame));
      }
      fx.push_back(Eff(PreviewEffectKind::ResolveCreate));
      return Ok(s, std::move(fx), from);
    }
    case PreviewInputKind::Play: {
      if (from == PreviewState::Ended) {
        return BeginSeek(s, s.seekableStartUs, SeekMode::Accurate, true, from);
      }
      if (from != PreviewState::Ready && from != PreviewState::Paused) {
        return Illegal(s);
      }
      s.state = PreviewState::Playing;
      s.atLiveEdge = s.isRecording;
      std::vector<PreviewEffect> fx;
      PreviewEffect clk = Eff(PreviewEffectKind::ClockSetRate);
      clk.rate = 1;
      clk.tUs = nowMediaUs;
      fx.push_back(clk);
      fx.push_back(Eff(PreviewEffectKind::AudioStart));
      fx.push_back(Eff(PreviewEffectKind::ResolvePlay));
      return Ok(s, std::move(fx), from);
    }
    case PreviewInputKind::Pause: {
      if (from != PreviewState::Playing) return Illegal(s);
      s.state = PreviewState::Paused;
      s.atLiveEdge = false;
      std::vector<PreviewEffect> fx;
      PreviewEffect clk = Eff(PreviewEffectKind::ClockSetRate);
      clk.rate = 0;
      clk.tUs = nowMediaUs;
      fx.push_back(clk);
      fx.push_back(Eff(PreviewEffectKind::AudioPause));
      fx.push_back(Eff(PreviewEffectKind::ResolvePause));
      return Ok(s, std::move(fx), from);
    }
    case PreviewInputKind::Seek: {
      if (from == PreviewState::Idle || from == PreviewState::Preparing ||
          from == PreviewState::Released) {
        return Illegal(s);
      }
      const bool resume = from == PreviewState::Playing ||
                          (from == PreviewState::Seeking && s.resumeAfter) ||
                          (from == PreviewState::Buffering && s.resumeAfter);
      if (from == PreviewState::Seeking) {
        HandleResult inner =
            BeginSeek(s, input.tUs, input.mode, resume, from);
        inner.effects.insert(inner.effects.begin(),
                             Eff(PreviewEffectKind::EmitSuperseded));
        return inner;
      }
      return BeginSeek(s, input.tUs, input.mode, resume, from);
    }
    case PreviewInputKind::SeekLiveEdge: {
      if (!s.isLive) return Illegal(s);
      const int64_t t = s.liveEdgeUs - s.liveTargetLatencyUs;
      const bool resume = from == PreviewState::Playing || s.resumeAfter;
      auto inner = BeginSeek(s, t, SeekMode::Accurate, resume, from);
      inner.state.atLiveEdge = true;
      return inner;
    }
    case PreviewInputKind::FirstFrameShown: {
      if (from != PreviewState::Seeking && from != PreviewState::Preparing) {
        return Illegal(s);
      }
      if (input.gen != s.gen) {
        HandleResult r;
        r.state = s;
        return r;
      }
      s.positionUs = input.shownPtsUs != 0 ? input.shownPtsUs : input.tUs;
      std::vector<PreviewEffect> fx;
      if (from == PreviewState::Preparing) {
        s.state = PreviewState::Ready;
        fx.push_back(Eff(PreviewEffectKind::EmitFirstFrame));
        fx.push_back(Eff(PreviewEffectKind::ResolveCreate));
        return Ok(s, std::move(fx), from);
      }
      s.state = s.resumeAfter ? PreviewState::Playing : PreviewState::Paused;
      PreviewEffect clk = Eff(PreviewEffectKind::ClockSetRate);
      clk.rate = s.resumeAfter ? 1 : 0;
      clk.tUs = s.positionUs;
      fx.push_back(clk);
      if (s.resumeAfter) {
        fx.push_back(Eff(PreviewEffectKind::AudioStart));
      }
      PreviewEffect done = Eff(PreviewEffectKind::EmitSeekCompleted);
      done.tUs = s.positionUs;
      done.actualUs = s.positionUs;
      fx.push_back(done);
      fx.push_back(Eff(PreviewEffectKind::ResolveSeek));
      return Ok(s, std::move(fx), from);
    }
    case PreviewInputKind::DataStarved: {
      if (from != PreviewState::Playing) return Illegal(s);
      s.state = PreviewState::Buffering;
      s.resumeAfter = true;
      std::vector<PreviewEffect> fx;
      PreviewEffect clk = Eff(PreviewEffectKind::ClockSetRate);
      clk.rate = 0;
      clk.tUs = nowMediaUs;
      fx.push_back(clk);
      fx.push_back(Eff(PreviewEffectKind::AudioPause));
      return Ok(s, std::move(fx), from);
    }
    case PreviewInputKind::DataAvailable: {
      if (from != PreviewState::Buffering) return Illegal(s);
      s.state = PreviewState::Playing;
      std::vector<PreviewEffect> fx;
      PreviewEffect clk = Eff(PreviewEffectKind::ClockSetRate);
      clk.rate = 1;
      clk.tUs = nowMediaUs;
      fx.push_back(clk);
      fx.push_back(Eff(PreviewEffectKind::AudioStart));
      return Ok(s, std::move(fx), from);
    }
    case PreviewInputKind::VideoEos:
      s.videoEos = true;
      break;
    case PreviewInputKind::AudioEos:
      s.audioEos = true;
      break;
    case PreviewInputKind::StepFrame: {
      if (from != PreviewState::Paused && from != PreviewState::Ready) {
        return Illegal(s);
      }
      if (input.stepDir < 0) {
        return BeginSeek(s, nowMediaUs - 1, SeekMode::Accurate, false, from);
      }
      return BeginSeek(s, nowMediaUs + 1, SeekMode::Accurate, false, from);
    }
    case PreviewInputKind::AudioFailed: {
      if (!Active(from)) return Illegal(s);
      s.audioPlayable = false;
      s.noAudio = true;
      std::vector<PreviewEffect> fx;
      fx.push_back(Eff(PreviewEffectKind::SwitchMonotonicClock));
      PreviewEffect ev = Eff(PreviewEffectKind::EmitAudioUnavailable);
      ev.code = input.status.errorCode;
      ev.message = input.status.errorMessage;
      fx.push_back(ev);
      if (s.audioRequired) {
        s.state = PreviewState::Error;
        fx.push_back(Eff(PreviewEffectKind::EmitError));
      }
      return Ok(s, std::move(fx), from);
    }
    case PreviewInputKind::Evicted: {
      if (!Active(from)) return Illegal(s);
      const int64_t prev = nowMediaUs;
      const bool resume = from == PreviewState::Playing || s.resumeAfter;
      HandleResult inner =
          BeginSeek(s, s.seekableStartUs, SeekMode::Keyframe, resume, from);
      PreviewEffect ev = Eff(PreviewEffectKind::EmitPositionEvicted);
      ev.tUs = prev;
      ev.actualUs = s.seekableStartUs;
      inner.effects.insert(inner.effects.begin(), ev);
      return inner;
    }
    case PreviewInputKind::SurfaceDetached: {
      if (!Active(from)) return Illegal(s);
      s.videoAttached = false;
      std::vector<PreviewEffect> fx;
      fx.push_back(Eff(PreviewEffectKind::ReleaseDecoder));
      return Ok(s, std::move(fx), from);
    }
    case PreviewInputKind::SurfaceAttached: {
      if (!Active(from)) return Illegal(s);
      s.videoAttached = true;
      const bool resume = from == PreviewState::Playing || s.resumeAfter;
      HandleResult inner =
          BeginSeek(s, nowMediaUs, SeekMode::Accurate, resume, from);
      inner.effects.insert(inner.effects.begin(),
                           Eff(PreviewEffectKind::RequestDecoder));
      return inner;
    }
    case PreviewInputKind::AppBackground: {
      if (from != PreviewState::Playing || !s.pauseOnBackground) {
        HandleResult r;
        r.state = s;
        return r;
      }
      PreviewInput pause;
      pause.kind = PreviewInputKind::Pause;
      return Handle(s, pause, nowMediaUs, nowNs);
    }
    case PreviewInputKind::RendererFailed: {
      if (!Active(from)) return Illegal(s);
      const bool recent =
          s.lastRendererFailNs > 0 &&
          nowNs > 0 && nowNs - s.lastRendererFailNs < 5'000'000'000LL;
      s.rendererFailCount = recent ? s.rendererFailCount + 1 : 1;
      s.lastRendererFailNs = nowNs;
      if (s.rendererFailCount >= 2) {
        s.state = PreviewState::Error;
        std::vector<PreviewEffect> fx;
        PreviewEffect err = Eff(PreviewEffectKind::EmitError);
        err.code = kErrPreviewRenderFailed;
        fx.push_back(err);
        return Ok(s, std::move(fx), from);
      }
      const bool resume = from == PreviewState::Playing || s.resumeAfter;
      return BeginSeek(s, nowMediaUs, SeekMode::Keyframe, resume, from);
    }
    case PreviewInputKind::BufferFinished: {
      s.isRecording = false;
      s.seekableEndUs = input.tUs > 0 ? input.tUs : s.liveEdgeUs;
      HandleResult r;
      r.state = s;
      return r;
    }
    case PreviewInputKind::Release: {
      if (from == PreviewState::Released) {
        HandleResult r;
        r.state = s;
        return r;
      }
      s.state = PreviewState::Released;
      std::vector<PreviewEffect> fx;
      PreviewEffect flush = Eff(PreviewEffectKind::FlushAll);
      s.gen += 1;
      flush.gen = s.gen;
      fx.push_back(flush);
      fx.push_back(Eff(PreviewEffectKind::ReleaseDecoder));
      return Ok(s, std::move(fx), from);
    }
  }

  if (s.videoEos && (s.audioEos || s.noAudio || !s.audioPlayable) &&
      from == PreviewState::Playing) {
    if (s.loop) {
      return BeginSeek(s, s.seekableStartUs, SeekMode::Accurate, true, from);
    }
    s.state = PreviewState::Ended;
    std::vector<PreviewEffect> fx;
    PreviewEffect clk = Eff(PreviewEffectKind::ClockSetRate);
    clk.rate = 0;
    clk.tUs = nowMediaUs;
    fx.push_back(clk);
    fx.push_back(Eff(PreviewEffectKind::AudioPause));
    fx.push_back(Eff(PreviewEffectKind::EmitEnded));
    return Ok(s, std::move(fx), from);
  }

  HandleResult r;
  r.state = s;
  return r;
}

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
