#include "VideoEntry.h"

#include "VideoLog.h"
#include "codec/CodecCatalog.h"
#include "codec/CodecLog.h"
#include "codec/CodecRuntime.h"
#include "codec/CodecSelector.h"
#include "core/KeyframeThumbCache.h"
#include "decode/DecoderBackend.h"

namespace sherpa_onnx {
namespace video {

Status VideoEntry::ReadAudioPacket(int64_t index, EncodedPacket* out) {
  (void)index;
  (void)out;
  return Status::Fail(kErrNoAudioTrack, "no audio track");
}

void VideoEntry::SetDecodePolicy(std::optional<sherpa_onnx::codec::Policy> p) {
  std::lock_guard<std::mutex> lock(mu_);
  decodePolicy_ = p;
}

std::optional<sherpa_onnx::codec::Policy> VideoEntry::decodePolicy() const {
  std::lock_guard<std::mutex> lock(mu_);
  return decodePolicy_;
}

void VideoEntry::FillCodecInfo(VideoBufferInfo* info) const {
  if (info == nullptr) return;
  std::lock_guard<std::mutex> lock(mu_);
  if (!lastDecision_.provider.empty()) {
    info->decoderJson = sherpa_onnx::codec::DecisionToJson(lastDecision_);
  }
}

namespace {

sherpa_onnx::codec::Request MakeDecodeRequest(
    const std::string& owner, const VideoTrackInfo& track,
    sherpa_onnx::codec::Policy policy, sherpa_onnx::codec::Use use) {
  sherpa_onnx::codec::Request req;
  req.media = sherpa_onnx::codec::Media::Video;
  req.dir = sherpa_onnx::codec::Direction::Decode;
  req.use = use;
  req.stream.codec = VideoCodecName(track.codec);
  req.stream.width = track.codedWidth;
  req.stream.height = track.codedHeight;
  if (track.nominalFps.num > 0 && track.nominalFps.den > 0) {
    req.stream.fps = static_cast<double>(track.nominalFps.num) /
                     static_cast<double>(track.nominalFps.den);
  }
  req.policy = policy;
  req.ownerKey = owner;
  return req;
}

}  // namespace

std::shared_ptr<DecodeSession> VideoEntry::StickySession(
    std::optional<sherpa_onnx::codec::Policy> operation) {
  std::lock_guard<std::mutex> lock(mu_);
  const auto resolved =
      sherpa_onnx::codec::CodecRuntime::Instance().ResolveVideo(
          sherpa_onnx::codec::Use::Cpu, operation, decodePolicy_);
  if (sticky_ && stickyPolicy_ == resolved) {
    return sticky_;
  }

  VideoTrackInfo track;
  if (packets()) {
    track = packets()->track();
  }
  const auto found = sherpa_onnx::codec::CodecCatalog::Instance().Find(
      sherpa_onnx::codec::Media::Video, sherpa_onnx::codec::Direction::Decode,
      VideoCodecName(track.codec));
  if (found.empty()) {
    if (sticky_) {
      return sticky_;
    }
    auto acquired = DecoderPool::Instance().Acquire(id_);
    if (!acquired.ok() || !acquired.value) {
      lastStickyError_ = acquired.status;
      return nullptr;
    }
    stickyDecoder_ = acquired.value;
    sticky_ = std::make_shared<DecodeSession>(id_, packets(), timeline(), cache_,
                                              stickyDecoder_);
    sticky_->SetGenerationSource([this] { return generation_.load(); });
    if (packets()) {
      sticky_->SetTrack(packets()->track());
    }
    stickyPolicy_ = resolved;
    return sticky_;
  }

  if (sticky_) {
    sticky_.reset();
    stickyDecoder_.reset();
    stickyLease_.Reset();
  }

  auto req = MakeDecodeRequest(id_, track, resolved, sherpa_onnx::codec::Use::Cpu);
  auto selected = sherpa_onnx::codec::Select<DecoderBackend>(
      req, sherpa_onnx::codec::CodecArbiter::Instance(),
      [&](const sherpa_onnx::codec::Provider& p) {
        sherpa_onnx::codec::Result<std::unique_ptr<DecoderBackend>> opened;
        auto dec = OpenDecoderForProvider(p.name);
        if (!dec) {
          opened.status = sherpa_onnx::codec::Status::Fail(
              kErrDecoderUnavailable, "open");
          return opened;
        }
        auto st = dec->Configure(track);
        if (!st.ok) {
          opened.status = sherpa_onnx::codec::Status::Fail(
              st.errorCode.c_str(), st.errorMessage);
          return opened;
        }
        opened.value = std::move(dec);
        return opened;
      });
  if (!selected.ok()) {
    lastStickyError_ = Status::Fail(selected.status.errorCode.c_str(),
                                    selected.status.errorMessage);
    lastStickyError_.codecReason =
        sherpa_onnx::codec::ReasonName(selected.decision.fallbackReason);
    lastStickyError_.codecTier =
        sherpa_onnx::codec::TierName(selected.decision.tier);
    lastDecision_ = selected.decision;
    return nullptr;
  }
  lastDecision_ = selected.decision;
  stickyLease_ = std::move(selected.lease);
  stickyDecoder_ = std::shared_ptr<DecoderBackend>(selected.backend.release());
  sticky_ = std::make_shared<DecodeSession>(id_, packets(), timeline(), cache_,
                                            stickyDecoder_);
  sticky_->SetGenerationSource([this] { return generation_.load(); });
  sticky_->SetTrack(track);
  sticky_->MarkConfigured();
  stickyPolicy_ = resolved;
  lastStickyError_ = Status::Ok();
  return sticky_;
}

bool VideoEntry::TryMidstreamSoftwareFallback() {
  std::lock_guard<std::mutex> lock(mu_);
  if (midstreamUsed_) {
    return false;
  }
  const auto resolved =
      sherpa_onnx::codec::CodecRuntime::Instance().ResolveVideo(
          sherpa_onnx::codec::Use::Cpu, std::nullopt, decodePolicy_);
  if (resolved != sherpa_onnx::codec::Policy::PreferHardware) {
    return false;
  }
  if (!stickyDecoder_ || !stickyDecoder_->IsReclaimed()) {
    if (lastStickyError_.errorCode != kErrDecodeFailed &&
        lastStickyError_.errorCode != kErrDecoderUnavailable) {
      // allow fallback on first-frame decode failure too
    }
  }
  midstreamUsed_ = true;
  const std::string from = lastDecision_.provider;
  sticky_.reset();
  stickyDecoder_.reset();
  stickyLease_.Reset();
  decodePolicy_ = sherpa_onnx::codec::Policy::Software;
  CODEC_LOGI("codec.midstream owner=%s from=%s reopen=software", id_.c_str(),
             from.c_str());
  return true;
}

void VideoEntry::DropStickySession() {
  std::lock_guard<std::mutex> lock(mu_);
  sticky_.reset();
  if (stickyDecoder_) {
    DecoderPool::Instance().Release(id_);
    stickyDecoder_.reset();
    DecoderPool::Instance().CloseUnused(DecoderClass::Cpu, id_);
  }
  stickyLease_.Reset();
}

void VideoEntry::OnMemoryPressure(MemoryPressureLevel level) {
  VIDEO_LOGI("video.cache pressure level=%d id=%s", static_cast<int>(level),
             id_.c_str());
  if (cache_) {
    cache_->ShrinkToPinned();
  }
  if (level == MemoryPressureLevel::Critical) {
    DropStickySession();
    DecoderPool::Instance().CloseIdle();
  }
}

}  // namespace video
}  // namespace sherpa_onnx
