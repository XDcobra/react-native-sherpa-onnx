#include "preview/PreviewPlayer.h"

#include "VideoLog.h"
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
  auto r = PlaybackController::Handle(state_, input, nowMediaUs, nowNs);
  if (r.status.ok) {
    const PreviewState prev = state_.state;
    state_ = r.state;
    lastEffects_ = r.effects;
    ExecuteEffects(r.effects);
    if (prev != state_.state) {
      std::ostringstream j;
      j << "{\"state\":\"" << PreviewStateName(state_.state)
        << "\",\"previousState\":\"" << PreviewStateName(prev) << "\"}";
      Emit("stateChanged", j.str());
    }
  } else {
    lastEffects_.clear();
  }
  return r;
}

void PreviewPlayer::Emit(const std::string& type, const std::string& json) {
  PreviewRegistry::Instance().Emit(type, id_, json);
}

void PreviewPlayer::SetVolume(float v) {
  volume_ = v < 0 ? 0 : (v > 1 ? 1 : v);
  if (audio_) audio_->SetVolume(muted_ ? 0.f : volume_);
}

void PreviewPlayer::SetMuted(bool muted) {
  muted_ = muted;
  if (audio_) audio_->SetVolume(muted_ ? 0.f : volume_);
}

void PreviewPlayer::SetLoop(bool loop) { state_.loop = loop; }

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
    video_->onEos = [this](uint64_t) {
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
    afeed_->Start(e.tUs, e.gen);
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
        if (clock_) clock_->SetRate(e.rate, e.tUs);
        if (e.rate > 0 && audio_) {
          audioClock_.ResetSegment(e.tUs, audio_->FramesWritten());
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
  if (audio_ && state_.audioPlayable &&
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
    auto st = r->Configure(entry_->packets()->track());
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
