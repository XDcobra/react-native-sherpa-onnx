#include "preview/PreviewPlayer.h"

#include "VideoLog.h"
#include "codec/CodecCatalog.h"
#include "codec/CodecPolicy.h"
#include "codec/CodecRuntime.h"
#include "core/Timeline.h"
#include "core/Uuid.h"

#ifdef __ANDROID__
#include "platform/android/MediaCodecSurfaceRenderer.h"
#include <android/native_window.h>
#endif

#include <chrono>
#include <cmath>
#include <sstream>

#if defined(__APPLE__)
#include <mach/mach_time.h>
#endif
#if defined(__linux__) || defined(__ANDROID__)
#include <time.h>
#endif

namespace sherpa_onnx {
namespace video {
namespace preview {

namespace {

int64_t HostNowNs() {
#if defined(__APPLE__)
  static mach_timebase_info_data_t tb;
  static bool once = false;
  if (!once) {
    mach_timebase_info(&tb);
    once = true;
  }
  return static_cast<int64_t>(mach_absolute_time() * tb.numer / tb.denom);
#elif defined(__linux__) || defined(__ANDROID__)
  struct timespec ts {};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<int64_t>(ts.tv_sec) * 1000000000LL + ts.tv_nsec;
#else
  using namespace std::chrono;
  return duration_cast<nanoseconds>(steady_clock::now().time_since_epoch())
      .count();
#endif
}

std::string AudioStatusJson(const PreviewPlayer& p, const VideoBufferInfo& info) {
  const auto d = p.state().audioDecision;
  if (d == AudioDecision::Off || p.state().audioOff) {
    return "{\"status\":\"off\"}";
  }
  if (d == AudioDecision::Absent) {
    return "{\"status\":\"unavailable\",\"reason\":\"absent\","
           "\"code\":\"VIDEO_NO_AUDIO_TRACK\",\"codec\":null}";
  }
  if (d == AudioDecision::Unsupported) {
    std::string codec = "null";
    if (info.audio) {
      codec = std::string("\"") +
              (info.audio->codecName.empty()
                   ? AudioCodecName(info.audio->codec)
                   : info.audio->codecName) +
              "\"";
    }
    return "{\"status\":\"unavailable\",\"reason\":\"unsupportedCodec\","
           "\"code\":\"VIDEO_AUDIO_CODEC_UNSUPPORTED\",\"codec\":" +
           codec + "}";
  }
  std::string codec = "unknown";
  int sr = 0, ch = 0;
  if (info.audio) {
    codec = info.audio->codecName.empty() ? AudioCodecName(info.audio->codec)
                                          : info.audio->codecName;
    sr = info.audio->sampleRate;
    ch = info.audio->channels;
  }
  const char* st = p.muted() ? "muted" : "playing";
  std::ostringstream o;
  o << "{\"status\":\"" << st << "\",\"codec\":\"" << codec
    << "\",\"sampleRate\":" << sr << ",\"channels\":" << ch << "}";
  return o.str();
}

}  // namespace

PreviewPlayer::PreviewPlayer(std::string id, std::shared_ptr<VideoEntry> entry,
                             PreviewPlayerOptions opts)
    : id_(std::move(id)), entry_(std::move(entry)), opts_(std::move(opts)) {
  state_.audioRequired = opts_.controller.audioRequired;
  state_.audioOff = opts_.controller.audioOff;
  state_.loop = opts_.controller.loop;
  desiredLoop_.store(opts_.controller.loop);
  state_.pauseOnBackground = opts_.controller.pauseOnBackground;
  state_.isLive = opts_.controller.isLive;
  state_.liveTargetLatencyUs = opts_.controller.liveTargetLatencyUs;
  state_.liveMaxLatencyUs = opts_.controller.liveMaxLatencyUs;
  state_.audioDecision = opts_.audioDecision;
  state_.noAudio = opts_.audioDecision != AudioDecision::Track;
  state_.audioPlayable = opts_.audioDecision == AudioDecision::Track;
  volume_ = opts_.volume;
  muted_ = opts_.muted;
  if (entry_) {
    auto info = entry_->Info();
    state_.isRecording = info.state == VideoBufferState::Recording;
    state_.seekableStartUs = info.seekableRange.startUs;
    state_.seekableEndUs = info.seekableRange.endUs;
    state_.liveEdgeUs = info.liveEdgeUs;
  }
  clock_ = std::make_unique<MonotonicClock>();
}

PreviewPlayer::~PreviewPlayer() { StopPump(); }

int64_t PreviewPlayer::NowNs() const { return HostNowNs(); }

HandleResult PreviewPlayer::Post(const PreviewInput& input, int64_t nowMediaUs,
                                 int64_t nowNs) {
  std::lock_guard<std::recursive_mutex> lock(mu_);
  // Apply the latest setLoop even if it raced with this Post (JS can enable
  // loop while Playing; the pump may already be inside Handle/EOS).
  state_.loop = desiredLoop_.load();
  PreviewInput resolved = input;
  if (input.kind == PreviewInputKind::StepFrame) {
    bool atEdge = false;
    int64_t toIdx = -1;
    int64_t targetUs =
        input.stepDir < 0 ? nowMediaUs - 1 : nowMediaUs + 1;
    const Timeline* tl = entry_ ? entry_->timeline() : nullptr;
    if (tl) {
      toIdx = tl->NeighborSample(nowMediaUs, input.stepDir, &atEdge);
      SampleEntry s;
      if (toIdx >= 0 && tl->Get(toIdx, &s).ok) {
        targetUs = s.ptsUs;
      }
    }
    if (atEdge) {
      HandleResult edge;
      edge.state = state_;
      return edge;
    }
    resolved.tUs = targetUs;
    resolved.hasTarget = true;
  }
  auto r = PlaybackController::Handle(state_, resolved, nowMediaUs, nowNs);
  if (r.status.ok) {
    const PreviewState prev = state_.state;
    r.state.loop = desiredLoop_.load();
    state_ = r.state;
    lastEffects_ = r.effects;
    ExecuteEffects(r.effects);
    if (prev != state_.state) {
      std::ostringstream j;
      j << "{\"state\":\"" << PreviewStateName(state_.state)
        << "\",\"previousState\":\"" << PreviewStateName(prev)
        << "\",\"positionMs\":" << (state_.positionUs / 1000) << "}";
      Emit("stateChanged", j.str());
    }
  } else {
    VIDEO_LOGW("video.preview.reject id=%s input=%s state=%s code=%s msg=%s",
               id_.c_str(), PreviewInputKindName(input.kind),
               PreviewStateName(state_.state), r.status.errorCode.c_str(),
               r.status.errorMessage.c_str());
    lastEffects_.clear();
  }
  return r;
}

void PreviewPlayer::Emit(const std::string& type, const std::string& json) {
  PreviewRegistry::Instance().Emit(type, id_, json);
}

void PreviewPlayer::EmitProgress(bool force) {
  const int64_t posMs = state_.positionUs / 1000;
  const int intervalMs =
      opts_.progressIntervalMs < 50
          ? 50
          : (opts_.progressIntervalMs > 5000 ? 5000 : opts_.progressIntervalMs);
  const int64_t intervalNs = static_cast<int64_t>(intervalMs) * 1'000'000LL;
  const int64_t nowNs = NowNs();
  if (!force) {
    if (posMs == lastEmittedPosMs_) return;
    if (lastProgressEmitNs_ > 0 && nowNs - lastProgressEmitNs_ < intervalNs) {
      return;
    }
  }
  lastEmittedPosMs_ = posMs;
  lastProgressEmitNs_ = nowNs;
  const int64_t wallMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch())
          .count();
  std::ostringstream j;
  j << "{\"positionMs\":" << posMs << ",\"seekableRange\":{\"startMs\":"
    << (state_.seekableStartUs / 1000) << ",\"endMs\":"
    << (state_.seekableEndUs / 1000) << "},\"liveEdgeMs\":";
  if (state_.isLive) {
    j << (state_.liveEdgeUs / 1000);
  } else {
    j << "null";
  }
  j << ",\"nativeTimestampMs\":" << wallMs << "}";
  Emit("progress", j.str());
}

void PreviewPlayer::SetVolume(float v) {
  volume_ = v < 0 ? 0 : (v > 1 ? 1 : v);
  if (audio_) audio_->SetVolume(muted_ ? 0.f : volume_);
}

void PreviewPlayer::SetMuted(bool muted) {
  muted_ = muted;
  if (audio_) audio_->SetVolume(muted_ ? 0.f : volume_);
}

void PreviewPlayer::SetLoop(bool loop) {
  desiredLoop_.store(loop);
  std::lock_guard<std::recursive_mutex> lock(mu_);
  state_.loop = loop;
  opts_.controller.loop = loop;
  if (loop && state_.state == PreviewState::Ended) {
    PreviewInput in;
    in.kind = PreviewInputKind::Play;
    Post(in, state_.positionUs, NowNs());
  }
}

std::string PreviewPlayer::SnapshotJson() const {
  VideoBufferInfo info;
  if (entry_) info = entry_->Info();
  const int64_t posMs = state_.positionUs / 1000;
  const bool liveRec = state_.isLive && state_.isRecording;
  std::ostringstream o;
  o << "{\"playerId\":\"" << id_ << "\",\"bufferId\":\""
    << (entry_ ? entry_->id() : "") << "\",\"bufferKind\":\""
    << (info.kind == VideoKind::Live ? "liveVideoBuffer" : "offlineVideoBuffer")
    << "\",\"state\":\"" << PreviewStateName(state_.state)
    << "\",\"positionMs\":" << posMs << ",\"durationMs\":";
  if (liveRec) {
    o << "null";
  } else {
    o << (info.seekableRange.endUs / 1000);
  }
  o << ",\"seekableRange\":{\"startMs\":" << (state_.seekableStartUs / 1000)
    << ",\"endMs\":" << (state_.seekableEndUs / 1000) << "},\"liveEdgeMs\":";
  if (state_.isLive) {
    o << (state_.liveEdgeUs / 1000);
  } else {
    o << "null";
  }
  o << ",\"atLiveEdge\":" << (state_.atLiveEdge ? "true" : "false")
    << ",\"playbackRate\":1,\"videoAttached\":"
    << (state_.videoAttached ? "true" : "false") << ",\"audio\":"
    << AudioStatusJson(*this, info) << ",\"stats\":{\"framesRendered\":";
  VideoRenderStats st;
  if (video_) st = video_->stats();
  o << st.rendered << ",\"framesDropped\":" << st.dropped
    << ",\"audioUnderruns\":0,\"avOffsetMs\":" << st.avOffsetMsMean << "}}";
  return o.str();
}

void PreviewPlayer::StartFeeds(const PreviewEffect& e) {
  gen_.store(e.gen);
  if (video_ && entry_) {
    vfeed_ = std::make_unique<VideoFeeder>(entry_, video_);
    vfeed_->Start(e.tUs, e.mode, e.gen);
    video_->SetPrerollUntil(e.tUs);
    video_->onFirstFrameShown = [this](uint64_t g, int64_t pts) {
      PreviewInput in;
      in.kind = PreviewInputKind::FirstFrameShown;
      in.gen = g;
      in.shownPtsUs = pts;
      Post(in, pts, NowNs());
      std::ostringstream j;
      j << "{\"positionMs\":" << (pts / 1000) << "}";
      Emit("firstFrameRendered", j.str());
    };
    video_->onEos = [this](uint64_t g) {
      const uint64_t current = gen_.load();
      if (g != 0 && g != current) {
        return;
      }
      PreviewInput in;
      in.kind = PreviewInputKind::VideoEos;
      Post(in, state_.positionUs, NowNs());
    };
    video_->onFailed = [this](Status) {
      PreviewInput in;
      in.kind = PreviewInputKind::RendererFailed;
      Post(in, state_.positionUs, NowNs());
    };
  }
  if (audio_ && entry_ && state_.audioPlayable && entry_->audioTrack()) {
    afeed_ = std::make_unique<AudioFeeder>(entry_, audio_);
    (void)afeed_->Configure(*entry_->audioTrack());
    if (entry_->audioTrack()->sampleRate > 0) {
      audioClock_.sampleRate = entry_->audioTrack()->sampleRate;
    }
    afeed_->Start(e.tUs, e.gen);
    afeed_->onEos = [this]() {
      PreviewInput in;
      in.kind = PreviewInputKind::AudioEos;
      Post(in, state_.positionUs, NowNs());
    };
    audio_->SetVolume(muted_ ? 0.f : volume_);
    audio_->onFailed = [this](Status st) {
      PreviewInput in;
      in.kind = PreviewInputKind::AudioFailed;
      in.status = st;
      Post(in, state_.positionUs, NowNs());
    };
  }
  if (video_ || audio_) EnsurePump();
}

void PreviewPlayer::ExecuteEffects(const std::vector<PreviewEffect>& fx) {
  PreviewInput pendingShown;
  bool haveShown = false;
  for (const auto& e : fx) {
    switch (e.kind) {
      case PreviewEffectKind::RequestDecoder: {
        auto slot = DecoderPool::Instance().AcquireSlot(DecoderClass::Display,
                                                        id_, 0);
        if (slot.ok()) {
          displaySlot_ = std::move(slot.value);
        } else {
          VIDEO_LOGW("video.preview decoder busy %s",
                     slot.status.errorMessage.c_str());
        }
        break;
      }
      case PreviewEffectKind::ReleaseDecoder:
        displaySlot_.Reset();
        break;
      case PreviewEffectKind::ClockSetRate:
        clockRate_ = e.rate;
        if (clock_) clock_->SetRate(e.rate, e.tUs);
        if (e.rate > 0 && audio_ && !state_.audioEos) {
          int64_t head = audio_->HeadPosition();
          int64_t fp = 0;
          int64_t nt = 0;
          if (audio_->Timestamp(&fp, &nt)) {
            head = fp;
          }
          if (entry_ && entry_->audioTrack() &&
              entry_->audioTrack()->sampleRate > 0) {
            audioClock_.sampleRate = entry_->audioTrack()->sampleRate;
          }
          audioClock_.ResetSegment(e.tUs, head, NowNs());
          audioClock_.framesWritten = audio_->FramesWritten();
          audioClock_.rate = e.rate;
        }
        break;
      case PreviewEffectKind::AudioStart:
        if (audio_) audio_->Start();
        break;
      case PreviewEffectKind::AudioPause:
        if (audio_) audio_->Pause();
        break;
      case PreviewEffectKind::FlushAll:
        gen_.store(e.gen);
        if (video_) video_->Flush(e.gen);
        if (audio_) audio_->Flush(e.gen);
        if (vfeed_) vfeed_->Flush(e.gen);
        if (afeed_) afeed_->Flush(e.gen);
        break;
      case PreviewEffectKind::StartFeed:
        StartFeeds(e);
        if (!video_) {
          pendingShown.kind = PreviewInputKind::FirstFrameShown;
          pendingShown.gen = e.gen;
          pendingShown.shownPtsUs = e.tUs;
          haveShown = true;
        }
        break;
      case PreviewEffectKind::EmitSeekCompleted: {
        const char* mode = "exact";
        if (e.mode == ::sherpa_onnx::video::SeekMode::Keyframe) {
          mode = "keyframe";
        }
        if (e.mode == ::sherpa_onnx::video::SeekMode::ClosestKeyframe) {
          mode = "closestKeyframe";
        }
        std::ostringstream j;
        j << "{\"result\":{\"status\":\"completed\",\"requestedMs\":"
          << (e.tUs / 1000) << ",\"actualMs\":" << (e.actualUs / 1000)
          << "},\"mode\":\"" << mode << "\"}";
        Emit("seekCompleted", j.str());
        EmitProgress(true);
        break;
      }
      case PreviewEffectKind::EmitEnded:
        Emit("ended", "{}");
        break;
      case PreviewEffectKind::EmitError: {
        std::ostringstream j;
        j << "{\"code\":\"" << e.code << "\",\"message\":\"" << e.message
          << "\"}";
        Emit("error", j.str());
        break;
      }
      case PreviewEffectKind::EmitAudioUnavailable: {
        std::ostringstream j;
        j << "{\"reason\":\"" << e.code << "\",\"code\":\"" << e.message
          << "\",\"message\":\"" << e.message
          << "\",\"codec\":null,\"atMs\":" << (e.tUs / 1000)
          << ",\"videoContinues\":true}";
        Emit("audioUnavailable", j.str());
        break;
      }
      case PreviewEffectKind::EmitPositionEvicted: {
        std::ostringstream j;
        j << "{\"previousMs\":" << (state_.positionUs / 1000) << ",\"newMs\":"
          << (e.actualUs / 1000) << "}";
        Emit("positionEvicted", j.str());
        break;
      }
      case PreviewEffectKind::EmitSeekClamped: {
        std::ostringstream j;
        j << "{\"requestedMs\":" << (e.tUs / 1000) << ",\"actualMs\":"
          << (e.actualUs / 1000) << ",\"reason\":\"" << e.message << "\"}";
        Emit("seekClamped", j.str());
        break;
      }
      case PreviewEffectKind::SwitchMonotonicClock: {
        int64_t now = clock_ ? clock_->NowMediaUs() : state_.positionUs;
        auto mono = std::make_unique<MonotonicClock>();
        mono->SetRate(1, now);
        clock_ = std::move(mono);
        if (audio_) audio_->Close();
        break;
      }
      default:
        break;
    }
  }
  if (haveShown) {
    // Apply without nested Post while still in Post's lock: update via Handle.
    auto r = PlaybackController::Handle(state_, pendingShown, pendingShown.shownPtsUs,
                                        NowNs());
    if (r.status.ok) {
      state_ = r.state;
    }
  }
}

void PreviewPlayer::PumpOnce() {
  std::lock_guard<std::recursive_mutex> lock(mu_);
  int64_t clockUs = state_.positionUs;
  if (clock_) clockUs = clock_->NowMediaUs();
  if (audio_ && state_.audioPlayable && !state_.audioEos &&
      state_.state == PreviewState::Playing) {
    int64_t fp = 0, nt = 0;
    if (audio_->Timestamp(&fp, &nt)) {
      audioClock_.OnTimestamp(fp, nt);
    } else {
      audioClock_.OnHead(audio_->HeadPosition());
    }
    audioClock_.framesWritten = audio_->FramesWritten();
    bool snapped = false;
    clockUs = audioClock_.ApplyGuards(audioClock_.Media(NowNs()), NowNs(),
                                      &snapped);
    state_.positionUs = clockUs;
  } else if (clock_) {
    state_.positionUs = clockUs;
  }
  if (state_.state == PreviewState::Playing) {
    EmitProgress(false);
  }
  if (vfeed_) vfeed_->Pump();
  if (afeed_) afeed_->Pump();
  if (video_) {
#ifdef __ANDROID__
    const int64_t vs =
        static_cast<int64_t>(1e9 / (refreshHz_ > 1 ? refreshHz_ : 60.0));
#else
    const int64_t vs = 16'666'666;
#endif
    video_->Drain(clockUs, NowNs(), vs);
  }
}

void PreviewPlayer::EnsurePump() {
  bool expected = false;
  if (!pumpRun_.compare_exchange_strong(expected, true)) return;
  pump_ = std::thread([this] {
    while (pumpRun_.load()) {
      PumpOnce();
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
  });
}

void PreviewPlayer::StopPump() {
  pumpRun_.store(false);
  if (pump_.joinable()) pump_.join();
}

#ifdef __ANDROID__
Status PreviewPlayer::AttachSurface(ANativeWindow* window, double refreshHz) {
  std::lock_guard<std::recursive_mutex> lock(mu_);
  refreshHz_ = refreshHz > 1 ? refreshHz : 60.0;
  auto r = std::make_unique<MediaCodecSurfaceRenderer>();
  r->SetWindow(window);
  r->SetRefreshHz(refreshHz_);
  if (entry_ && entry_->packets()) {
    const VideoTrackInfo& track = entry_->packets()->track();
    sherpa_onnx::codec::Request req;
    req.media = sherpa_onnx::codec::Media::Video;
    req.dir = sherpa_onnx::codec::Direction::Decode;
    req.use = sherpa_onnx::codec::Use::Display;
    req.stream.codec = VideoCodecName(track.codec);
    req.stream.width = track.codedWidth;
    req.stream.height = track.codedHeight;
    req.policy = sherpa_onnx::codec::CodecRuntime::Instance().ResolveVideo(
        sherpa_onnx::codec::Use::Display, opts_.decodePolicy,
        entry_->decodePolicy());
    req.ownerKey = id_;
    const auto plan =
        sherpa_onnx::codec::MakePlan(req, sherpa_onnx::codec::CodecCatalog::Instance());
    for (const auto& step : plan.steps) {
      if (!step.provider) continue;
      auto lease = sherpa_onnx::codec::CodecArbiter::Instance().TryAcquire(
          step.resource, id_);
      if (!lease.ok()) continue;
      displayLease_ = std::move(lease.value);
      displayDecision_.tier = step.provider->tier;
      displayDecision_.origin = step.provider->origin;
      displayDecision_.provider = step.provider->name;
      r->SetAllowedCodecName(step.provider->name);
      break;
    }
    auto st = r->Configure(track);
    if (!st.ok) return st;
  }
  ownedVideo_ = std::move(r);
  video_ = ownedVideo_.get();
  PreviewInput in;
  in.kind = PreviewInputKind::SurfaceAttached;
  Post(in, state_.positionUs, NowNs());
  return Status::Ok();
}

void PreviewPlayer::DetachSurface() {
  std::lock_guard<std::recursive_mutex> lock(mu_);
  PreviewInput in;
  in.kind = PreviewInputKind::SurfaceDetached;
  Post(in, state_.positionUs, NowNs());
  video_ = nullptr;
  ownedVideo_.reset();
}

void PreviewPlayer::SetRefreshHz(double hz) {
  refreshHz_ = hz > 1 ? hz : 60.0;
  auto* s = dynamic_cast<MediaCodecSurfaceRenderer*>(video_);
  if (s) s->SetRefreshHz(refreshHz_);
}
#endif

PreviewRegistry& PreviewRegistry::Instance() {
  static PreviewRegistry inst;
  return inst;
}

std::shared_ptr<PreviewPlayer> PreviewRegistry::Create(
    std::shared_ptr<VideoEntry> entry, PreviewPlayerOptions opts) {
  auto p = std::make_shared<PreviewPlayer>("vprev_" + UuidV4(), std::move(entry),
                                           std::move(opts));
  std::lock_guard<std::mutex> lock(mu_);
  map_[p->id()] = p;
  return p;
}

std::shared_ptr<PreviewPlayer> PreviewRegistry::Get(const std::string& id) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = map_.find(id);
  return it == map_.end() ? nullptr : it->second;
}

bool PreviewRegistry::Release(const std::string& id) {
  std::shared_ptr<PreviewPlayer> p;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = map_.find(id);
    if (it == map_.end()) return false;
    p = it->second;
    map_.erase(it);
  }
  if (p) {
    p->StopPump();
    PreviewInput in;
    in.kind = PreviewInputKind::Release;
    p->Post(in, p->state().positionUs);
  }
  return true;
}

std::vector<std::string> PreviewRegistry::Ids() {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<std::string> out;
  out.reserve(map_.size());
  for (const auto& kv : map_) out.push_back(kv.first);
  return out;
}

void PreviewRegistry::SetEventSink(EventFn fn) {
  std::lock_guard<std::mutex> lock(mu_);
  events_ = std::move(fn);
}

void PreviewRegistry::Emit(const std::string& type, const std::string& playerId,
                           const std::string& json) {
  EventFn fn;
  {
    std::lock_guard<std::mutex> lock(mu_);
    fn = events_;
  }
  if (fn) fn(type, playerId, json);
}

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
