#include "live/LiveVideoEntry.h"

#include "VideoLog.h"
#include "VideoRegistry.h"
#include "codec/CodecTypes.h"
#include "core/MemoryBudget.h"
#include "core/Uuid.h"

#include <chrono>

namespace sherpa_onnx {
namespace video {

std::shared_ptr<LiveVideoEntry> LiveVideoEntry::Create(
    const LiveVideoOptions& opts, const std::string& cacheDir) {
  auto e = std::make_shared<LiveVideoEntry>();
  e->id_ = "vid_live_" + UuidV4();
  e->kind_ = VideoKind::Live;
  e->opts_ = opts;
  e->cacheDir_ = cacheDir;
  e->cache_ = std::make_shared<DecodedFrameCache>();
  e->cache_->SetCacheDir(cacheDir);
  int64_t ringBytes = opts.ringMaxBytes;
  if (ringBytes <= 0) {
    ringBytes = MemoryBudget::DefaultRingMaxBytes(
        MemoryBudget::Instance().ramClass());
  }
  e->ring_.Configure(opts.ringSeconds, ringBytes);
  e->audioRing_.Configure(opts.ringSeconds, ringBytes / 4);
  return e;
}

Status LiveVideoEntry::SetCodecConfig(VideoCodec codec,
                                      std::vector<uint8_t> config,
                                      const VideoTrackInfo& track) {
  std::lock_guard<std::mutex> lock(mu_);
  if (state_ != VideoBufferState::Recording) {
    return Status::Fail(kErrInvalidState, "not recording");
  }
  track_ = track;
  track_.codec = codec;
  track_.codecConfig = std::move(config);
  codecSet_ = true;
  if (opts_.spool.mode != SpoolRetentionMode::None) {
    if (opts_.spool.directory.empty()) {
      opts_.spool.directory = cacheDir_;
    }
    auto st = spool_.Open(cacheDir_, id_, track_, opts_.spool,
                         audio_ ? &*audio_ : nullptr);
    (void)st;
  }
  return Status::Ok();
}

Status LiveVideoEntry::SetAudioConfig(const AudioTrackInfo& audio) {
  std::lock_guard<std::mutex> lock(mu_);
  if (state_ != VideoBufferState::Recording) {
    return Status::Fail(kErrInvalidState, "not recording");
  }
  audio_ = audio;
  return Status::Ok();
}

Status LiveVideoEntry::AppendPacket(const EncodedPacket& pkt) {
  std::lock_guard<std::mutex> lock(mu_);
  if (state_ != VideoBufferState::Recording) {
    return Status::Fail(kErrInvalidState, "append after finish");
  }
  auto st = ring_.Append(pkt, &timeline_);
  if (!st.ok) {
    return st;
  }
  if (spool_.active()) {
    spool_.Enqueue(pkt);
  }
  ++appendGen_;
  cv_.notify_all();
  if (eventFn_) {
    eventFn_("packetsAppended");
  }
  VideoRegistry::Instance().Emit("packetsAppended", id_, "{}");
  audioRing_.EvictBefore(ring_.rangeUs().startUs);
  return Status::Ok();
}

Status LiveVideoEntry::AppendAudioPacket(const EncodedPacket& pkt) {
  std::lock_guard<std::mutex> lock(mu_);
  if (state_ != VideoBufferState::Recording) {
    return Status::Fail(kErrInvalidState, "append after finish");
  }
  if (!audio_) {
    return Status::Fail(kErrNoAudioTrack, "no audio config");
  }
  auto st = audioRing_.Append(pkt, &audioTimeline_);
  if (!st.ok) return st;
  if (spool_.active()) {
    spool_.EnqueueAudio(pkt);
  }
  ++appendGen_;
  cv_.notify_all();
  return Status::Ok();
}

Status LiveVideoEntry::Finish() {
  std::lock_guard<std::mutex> lock(mu_);
  VideoBufferState expected = VideoBufferState::Recording;
  if (state_ != expected) {
    return Status::Fail(kErrInvalidState, "finish");
  }
  state_ = VideoBufferState::Finished;
  spool_.Finish();
  cv_.notify_all();
  if (eventFn_) {
    eventFn_("finished");
  }
  VideoRegistry::Instance().Emit("finished", id_, "{}");
  VIDEO_LOGI("video.live finished %s", id_.c_str());
  return Status::Ok();
}

VideoBufferInfo LiveVideoEntry::Info() const {
  std::lock_guard<std::mutex> lock(mu_);
  VideoBufferInfo i;
  i.bufferId = id_;
  i.kind = VideoKind::Live;
  i.state = state_;
  i.storageKind =
      spool_.active() ? VideoStorageKind::Spool : VideoStorageKind::Ring;
  i.track = track_;
  i.frameCount = timeline_.frameCount();
  i.frameCountExact = true;
  i.seekableRange.startUs = timeline_.startUs();
  i.seekableRange.endUs = timeline_.endUs();
  i.ringRange = ring_.rangeUs();
  i.spoolRange = spool_.rangeUs();
  i.liveEdgeUs = timeline_.endUs();
  i.totalFramesWritten = timeline_.frameCount() + ring_.droppedBeforeKey();
  i.ringEvictedFrames = ring_.evictedFrames();
  i.hasActiveSpool = spool_.active();
  if (audio_) {
    i.audio = audio_;
    i.audioRange.startUs = audioTimeline_.startUs();
    i.audioRange.endUs = audioTimeline_.endUs();
    i.audioPacketsWritten = audioTimeline_.size();
  }
  if (!lastDecision_.provider.empty()) {
    i.decoderJson = sherpa_onnx::codec::DecisionToJson(lastDecision_);
  }
  return i;
}

Status LiveVideoEntry::ReadAudioPacket(int64_t index, EncodedPacket* out) {
  if (audioRing_.Contains(index)) {
    return audioRing_.Read(index, out);
  }
  if (spool_.active()) {
    return spool_.ReadAudio(index, out);
  }
  return Status::Fail(kErrFrameEvicted, "audio evicted");
}

Status LiveVideoEntry::GetSample(int64_t decodeIndex, SampleEntry* out) const {
  const int64_t p = timeline_.PresentationOfDecode(decodeIndex);
  return timeline_.Get(p, out);
}

Status LiveVideoEntry::ReadPacket(int64_t decodeIndex, EncodedPacket* out) {
  const int64_t p = timeline_.PresentationOfDecode(decodeIndex);
  if (p < 0) {
    return Status::Fail(kErrFrameOutOfRange, "decode index");
  }
  if (ring_.Contains(p)) {
    return ring_.Read(p, out);
  }
  if (spool_.active()) {
    return spool_.Read(p, out);
  }
  SampleEntry s;
  timeline_.Get(p, &s);
  Status st = Status::Fail(kErrFrameEvicted, "evicted");
  st.errorMessage = "VIDEO_FRAME_EVICTED";
  return st;
}

void LiveVideoEntry::WaitAppend(int timeoutMs) {
  std::unique_lock<std::mutex> lock(mu_);
  const uint64_t g = appendGen_;
  cv_.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&] {
    return appendGen_ != g || state_ == VideoBufferState::Finished;
  });
}

void LiveVideoEntry::NotifyReaders() { cv_.notify_all(); }

}  // namespace video
}  // namespace sherpa_onnx
