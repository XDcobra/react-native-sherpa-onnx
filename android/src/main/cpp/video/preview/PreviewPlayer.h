#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "VideoEntry.h"
#include "codec/CodecArbiter.h"
#include "codec/CodecTypes.h"
#include "decode/DecoderPool.h"
#include "preview/AudioFeeder.h"
#include "preview/PlaybackClock.h"
#include "preview/PlaybackController.h"
#include "preview/Renderers.h"
#include "preview/VideoFeeder.h"

#ifdef __ANDROID__
struct ANativeWindow;
#endif

namespace sherpa_onnx {
namespace video {
namespace preview {

struct PreviewPlayerOptions {
  ControllerConfig controller;
  AudioDecision audioDecision = AudioDecision::Track;
  std::string codecName;
  std::optional<sherpa_onnx::codec::Policy> decodePolicy;
  float volume = 1.f;
  bool muted = false;
  int progressIntervalMs = 250;
};

class PreviewPlayer {
 public:
  PreviewPlayer(std::string id, std::shared_ptr<VideoEntry> entry,
                PreviewPlayerOptions opts);
  ~PreviewPlayer();

  const std::string& id() const { return id_; }
  const ControllerState& state() const { return state_; }
  const std::vector<PreviewEffect>& lastEffects() const { return lastEffects_; }
  std::shared_ptr<VideoEntry> entry() const { return entry_; }
  const PreviewPlayerOptions& options() const { return opts_; }

  HandleResult Post(const PreviewInput& input, int64_t nowMediaUs,
                    int64_t nowNs = 0);

  void SetClock(std::unique_ptr<IPlaybackClock> clock) {
    clock_ = std::move(clock);
  }
  void SetVideoRenderer(IVideoRenderer* r) { video_ = r; }
  void SetAudioRenderer(IAudioRenderer* r) { audio_ = r; }
  void TakeAudioRenderer(std::unique_ptr<IAudioRenderer> r) {
    ownedAudio_ = std::move(r);
    audio_ = ownedAudio_.get();
  }
  void TakeVideoRenderer(std::unique_ptr<IVideoRenderer> r) {
    ownedVideo_ = std::move(r);
    video_ = ownedVideo_.get();
  }
  IPlaybackClock* clock() { return clock_.get(); }
  IAudioRenderer* audioRenderer() { return audio_; }

  void ExecuteEffects(const std::vector<PreviewEffect>& fx);

  void SetVolume(float v);
  void SetMuted(bool muted);
  void SetLoop(bool loop);
  float volume() const { return volume_; }
  bool muted() const { return muted_; }

  std::string SnapshotJson() const;

#ifdef __ANDROID__
  Status AttachSurface(ANativeWindow* window, double refreshHz);
  void DetachSurface();
  void SetRefreshHz(double hz);
#endif

  void PumpOnce();
  void EnsurePump();
  void StopPump();

 private:
  void Emit(const std::string& type, const std::string& json);
  void EmitProgress(bool force);
  void StartFeeds(const PreviewEffect& e);
  int64_t NowNs() const;

  std::string id_;
  std::shared_ptr<VideoEntry> entry_;
  PreviewPlayerOptions opts_;
  ControllerState state_;
  std::vector<PreviewEffect> lastEffects_;
  std::unique_ptr<IPlaybackClock> clock_;
  IVideoRenderer* video_ = nullptr;
  IAudioRenderer* audio_ = nullptr;
  std::unique_ptr<IVideoRenderer> ownedVideo_;
  std::unique_ptr<IAudioRenderer> ownedAudio_;
  std::unique_ptr<VideoFeeder> vfeed_;
  std::unique_ptr<AudioFeeder> afeed_;
  DecoderSlot displaySlot_;
  std::atomic<uint64_t> gen_{0};
  std::atomic<bool> desiredLoop_{false};
  float volume_ = 1.f;
  bool muted_ = false;
  AudioClockEstimator audioClock_;
  std::atomic<bool> pumpRun_{false};
  std::thread pump_;
  mutable std::recursive_mutex mu_;
  double clockRate_ = 0;
  int64_t lastProgressEmitNs_ = 0;
  int64_t lastEmittedPosMs_ = -1;
#ifdef __ANDROID__
  double refreshHz_ = 60.0;
  sherpa_onnx::codec::Lease displayLease_;
  sherpa_onnx::codec::Decision displayDecision_;
#endif
};

class PreviewRegistry {
 public:
  using EventFn = std::function<void(const std::string& type,
                                     const std::string& playerId,
                                     const std::string& json)>;
  static PreviewRegistry& Instance();
  std::shared_ptr<PreviewPlayer> Create(std::shared_ptr<VideoEntry> entry,
                                        PreviewPlayerOptions opts);
  std::shared_ptr<PreviewPlayer> Get(const std::string& id);
  bool Release(const std::string& id);
  std::vector<std::string> Ids();
  void SetEventSink(EventFn fn);
  void Emit(const std::string& type, const std::string& playerId,
            const std::string& json);

 private:
  std::mutex mu_;
  std::unordered_map<std::string, std::shared_ptr<PreviewPlayer>> map_;
  EventFn events_;
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx
