#include "decode/DecodeSession.h"

#include "VideoLog.h"
#include "core/ColorConvert.h"

namespace sherpa_onnx {
namespace video {

DecodeSession::DecodeSession(std::string bufferId, PacketSource* source,
                             const Timeline* timeline,
                             std::shared_ptr<DecodedFrameCache> cache,
                             std::shared_ptr<DecoderBackend> decoder)
    : bufferId_(std::move(bufferId)),
      source_(source),
      timeline_(timeline),
      cache_(std::move(cache)),
      decoder_(std::move(decoder)) {
  if (source_) {
    track_ = source_->track();
  }
}

void DecodeSession::SetGenerationSource(std::function<uint64_t()> fn) {
  generationFn_ = std::move(fn);
  generationAtStart_ = generationFn_ ? generationFn_() : 0;
}

int DecodeSession::flushCount() const {
  return decoder_ ? decoder_->flushCount() : 0;
}

int DecodeSession::submitCount() const {
  return decoder_ ? decoder_->submitCount() : 0;
}

Status DecodeSession::EnsureConfigured() {
  if (configured_ || decoder_ == nullptr) {
    return configured_ ? Status::Ok()
                       : Status::Fail(kErrDecoderUnavailable, "no decoder");
  }
  auto st = decoder_->Configure(track_);
  if (st.ok) {
    configured_ = true;
  }
  return st;
}

Status DecodeSession::Flush() {
  sameGopReuse_ = false;
  lastDecodeIndex_ = -1;
  lastKeyframePres_ = -1;
  if (decoder_) {
    return decoder_->Flush();
  }
  return Status::Ok();
}

CacheKey DecodeSession::StoredNv12Key(int64_t pres) {
  CacheKey k;
  k.presentationIndex = pres;
  k.maxSideBucket = 0;
  k.format = VideoPixelFormat::Nv12;
  return k;
}

int64_t DecodeSession::PresentationOf(const DecodedRawFrame& raw) const {
  if (raw.presentationIndex >= 0) {
    return raw.presentationIndex;
  }
  if (timeline_ == nullptr) {
    return -1;
  }
  return timeline_->SampleAtPts(raw.ptsUs);
}

bool DecodeSession::CacheHasNv12(int64_t pres) const {
  return cache_ && cache_->Contains(StoredNv12Key(pres));
}

Status DecodeSession::InsertDecoded(const DecodedRawFrame& raw,
                                    bool cacheAlongWay, int64_t targetPres) {
  const int64_t pres = PresentationOf(raw);
  const bool isTarget = pres == targetPres;
  VIDEO_LOGI(
      "video.decode drain rawPres=%lld ptsUs=%lld mapped=%lld target=%lld "
      "along=%d",
      static_cast<long long>(raw.presentationIndex),
      static_cast<long long>(raw.ptsUs), static_cast<long long>(pres),
      static_cast<long long>(targetPres), cacheAlongWay ? 1 : 0);
  if (pres < 0) {
    VIDEO_LOGW("video.decode drain unmapped ptsUs=%lld target=%lld",
               static_cast<long long>(raw.ptsUs),
               static_cast<long long>(targetPres));
    return Status::Ok();
  }
  if (!isTarget && !cacheAlongWay) {
    return Status::Ok();
  }
  CacheKey k = StoredNv12Key(pres);
  auto st = cache_->InsertNv12(k, raw.view, raw.ptsUs, track_);
  if (!st.ok && isTarget) {
    return st;
  }
  return Status::Ok();
}

Status DecodeSession::DrainToCache(bool cacheAlongWay, int64_t targetPres) {
  if (decoder_ == nullptr || cache_ == nullptr) {
    return Status::Ok();
  }
  DecodedRawFrame raw;
  while (decoder_->Receive(&raw)) {
    if (generationFn_ && generationFn_() != generationAtStart_) {
      return Status::Fail(kErrCancelled, "buffer released mid-decode");
    }
    auto st = InsertDecoded(raw, cacheAlongWay, targetPres);
    if (!st.ok) {
      return st;
    }
  }
  return Status::Ok();
}

Status DecodeSession::DrainUntilCached(int64_t targetPres, bool cacheAlongWay) {
  auto st = DrainToCache(cacheAlongWay, targetPres);
  if (!st.ok) {
    return st;
  }
  if (CacheHasNv12(targetPres)) {
    return Status::Ok();
  }
  constexpr int64_t kOutputWaitUs = 20000;
  constexpr int kOutputWaitTries = 100;
  VIDEO_LOGI(
      "video.decode wait-output target=%lld submits=%d cached=%d",
      static_cast<long long>(targetPres),
      decoder_ ? decoder_->submitCount() : 0,
      cache_ ? cache_->cachedCount() : 0);
  for (int i = 0; i < kOutputWaitTries; ++i) {
    if (generationFn_ && generationFn_() != generationAtStart_) {
      return Status::Fail(kErrCancelled, "buffer released mid-decode");
    }
    DecodedRawFrame raw;
    if (decoder_->ReceiveWait(&raw, kOutputWaitUs)) {
      st = InsertDecoded(raw, cacheAlongWay, targetPres);
      if (!st.ok) {
        return st;
      }
    }
    if (CacheHasNv12(targetPres)) {
      VIDEO_LOGI("video.decode wait-output hit target=%lld tries=%d",
                 static_cast<long long>(targetPres), i + 1);
      return Status::Ok();
    }
  }
  VIDEO_LOGW(
      "video.decode wait-output timeout target=%lld cached=%d submits=%d",
      static_cast<long long>(targetPres),
      cache_ ? cache_->cachedCount() : 0,
      decoder_ ? decoder_->submitCount() : 0);
  return Status::Fail(kErrDecodeFailed, "decoder produced no target frame");
}

Status DecodeSession::SeekToKeyframe(int64_t keyPres) {
  const int64_t keyDec = timeline_->DecodeIndexOf(keyPres);
  sameGopReuse_ = false;
  auto st = decoder_->Flush();
  if (!st.ok) {
    return st;
  }
  lastDecodeIndex_ = -1;
  lastKeyframePres_ = keyPres;
  EncodedPacket pkt;
  st = source_->ReadPacket(keyDec, &pkt);
  if (!st.ok) {
    return st;
  }
  st = decoder_->Submit(pkt);
  if (!st.ok) {
    return st;
  }
  lastDecodeIndex_ = keyDec;
  return DrainUntilCached(keyPres, true);
}

Status DecodeSession::DecodeThrough(int64_t targetPres, bool cacheAlongWay) {
  const int64_t targetDec = timeline_->DecodeIndexOf(targetPres);
  for (int64_t d = lastDecodeIndex_ + 1; d <= targetDec; ++d) {
    if (generationFn_ && generationFn_() != generationAtStart_) {
      return Status::Fail(kErrCancelled, "buffer released mid-decode");
    }
    EncodedPacket pkt;
    auto st = source_->ReadPacket(d, &pkt);
    if (!st.ok) {
      return st;
    }
    st = decoder_->Submit(pkt);
    if (!st.ok) {
      return st;
    }
    lastDecodeIndex_ = d;
    st = DrainToCache(cacheAlongWay, targetPres);
    if (!st.ok) {
      return st;
    }
  }
  return DrainUntilCached(targetPres, cacheAlongWay);
}

Result<VideoFrameLease> DecodeSession::SeekAndAcquire(const FrameRequest& req) {
  Result<VideoFrameLease> r;
  if (source_ == nullptr || timeline_ == nullptr || cache_ == nullptr ||
      decoder_ == nullptr) {
    r.status = Status::Fail(kErrInvalidArgument, "DecodeSession");
    return r;
  }
  auto st = EnsureConfigured();
  if (!st.ok) {
    r.status = st;
    return r;
  }
  if (generationFn_) {
    generationAtStart_ = generationFn_();
  }
  if (timeline_->frameCount() <= 0) {
    r.status = Status::Fail(kErrFrameOutOfRange, "empty");
    return r;
  }
  int64_t pres = timeline_->SampleAtPts(req.ptsUs);
  if (pres < 0) {
    r.status = Status::Fail(kErrFrameOutOfRange, "pts");
    return r;
  }
  if (req.mode == SeekMode::Keyframe) {
    pres = timeline_->KeyframeAtOrBefore(pres);
  } else if (req.mode == SeekMode::ClosestKeyframe) {
    pres = timeline_->ClosestKeyframe(req.ptsUs);
  }
  SampleEntry target;
  st = timeline_->Get(pres, &target);
  if (!st.ok) {
    r.status = st;
    return r;
  }
  if (req.mode == SeekMode::Accurate && target.ptsUs != req.ptsUs) {
    // Accurate returns the frame covering pts (SampleAtPts), not an exact
    // sample timestamp match when VFR has gaps.
  }

  // Full-size NV12 is stored under bucket 0; derived sizes convert later.
  CacheKey stored = StoredNv12Key(pres);
  auto hit = cache_->Lookup(stored);
  if (hit.ok() && hit.value.valid()) {
    VIDEO_LOGI("video.decode cache hit idx=%lld",
               static_cast<long long>(pres));
    if (req.format == VideoPixelFormat::Nv12 && req.maxSide <= 0 &&
        !req.applyTransform) {
      return hit;
    }
    VideoFrameLease converted;
    st = MaybeConvert(hit.value, req, &converted);
    if (!st.ok) {
      r.status = st;
      return r;
    }
    r.value = std::move(converted);
    return r;
  }

  const int64_t keyPres = timeline_->KeyframeAtOrBefore(pres);
  const int64_t keyDec = timeline_->DecodeIndexOf(keyPres);
  const int64_t targetDec = timeline_->DecodeIndexOf(pres);
  const bool sameGopForward =
      lastDecodeIndex_ >= keyDec && lastDecodeIndex_ < targetDec &&
      lastKeyframePres_ == keyPres;
  if (!sameGopForward) {
    VIDEO_LOGI("video.decode seek mode=%d target=%lld key=%lld",
               static_cast<int>(req.mode), static_cast<long long>(pres),
               static_cast<long long>(keyPres));
    st = SeekToKeyframe(keyPres);
    if (!st.ok) {
      r.status = st;
      return r;
    }
    sameGopReuse_ = false;
  } else {
    sameGopReuse_ = true;
    VIDEO_LOGI("video.decode same-GOP forward idx=%lld",
               static_cast<long long>(pres));
  }

  const bool cacheAlong = true;
  if (req.mode == SeekMode::Keyframe) {
    // SeekToKeyframe already submitted the one key packet.
  } else {
    st = DecodeThrough(pres, cacheAlong);
    if (!st.ok) {
      r.status = st;
      return r;
    }
  }

  hit = cache_->Lookup(stored);
  if (!hit.ok() || !hit.value.valid()) {
    VIDEO_LOGE(
        "video.decode acquire miss idx=%lld ptsUs=%lld cached=%d submits=%d "
        "code=%s msg=%s",
        static_cast<long long>(pres), static_cast<long long>(req.ptsUs),
        cache_->cachedCount(), decoder_->submitCount(),
        hit.status.errorCode.c_str(), hit.status.errorMessage.c_str());
    r.status = Status::Fail(kErrDecodeFailed, "decoded frame missing");
    return r;
  }
  if (req.mode == SeekMode::Accurate) {
    SampleEntry got;
    timeline_->Get(hit.value.view().frameIndex, &got);
    if (got.ptsUs != target.ptsUs) {
      r.status = Status::Fail(kErrDecodeFailed, "pts mismatch");
      return r;
    }
  }
  if (req.format == VideoPixelFormat::Nv12 && req.maxSide <= 0 &&
      !req.applyTransform) {
    return hit;
  }
  VideoFrameLease converted;
  st = MaybeConvert(hit.value, req, &converted);
  if (!st.ok) {
    r.status = st;
    return r;
  }
  r.value = std::move(converted);
  return r;
}

Status DecodeSession::MaybeConvert(const VideoFrameLease& nv12,
                                   const FrameRequest& req,
                                   VideoFrameLease* out) {
  if (out == nullptr) {
    return Status::Fail(kErrInvalidArgument, "MaybeConvert");
  }
  Nv12View src;
  src.y.data = nv12.view().plane[0];
  src.y.stride = nv12.view().stride[0];
  src.uv.data = nv12.view().plane[1];
  src.uv.stride = nv12.view().stride[1];
  src.width = nv12.view().width;
  src.height = nv12.view().height;

  VideoTransform xf = req.applyTransform ? track_.transform : VideoTransform{};
  AlignedBuffer storage;
  VideoFrameView view;
  auto st = ColorConvert::Convert(src, req.format, xf, req.maxSide, req.packed,
                                  &storage, &view);
  if (!st.ok) {
    return st;
  }
  view.ptsUs = nv12.view().ptsUs;
  view.frameIndex = nv12.view().frameIndex;
  CacheKey k;
  k.presentationIndex = nv12.view().frameIndex;
  k.maxSideBucket = AnalysisSizeBucket(req.maxSide);
  k.format = req.format;
  k.applyTransform = req.applyTransform;
  k.packed = req.packed;
  st = cache_->InsertView(k, view, view.ptsUs);
  if (st.ok) {
    auto leased = cache_->Lookup(k);
    if (leased.ok()) {
      *out = std::move(leased.value);
      return Status::Ok();
    }
  }
  // Budget refused derived cache — still return a lease over the temp buffer.
  struct TempPin : FramePin {
    AlignedBuffer buf;
  };
  auto pin = std::make_shared<TempPin>();
  pin->buf = std::move(storage);
  view.plane[0] = pin->buf.data();
  if (req.format == VideoPixelFormat::Nv12) {
    view.plane[1] =
        view.plane[0] + static_cast<size_t>(view.stride[0]) * view.height;
  }
  *out = VideoFrameLease(view, std::move(pin));
  return Status::Ok();
}

}  // namespace video
}  // namespace sherpa_onnx
