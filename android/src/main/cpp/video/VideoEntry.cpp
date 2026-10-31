#include "VideoEntry.h"

#include "VideoLog.h"
#include "core/KeyframeThumbCache.h"

namespace sherpa_onnx {
namespace video {

Status VideoEntry::ReadAudioPacket(int64_t index, EncodedPacket* out) {
  (void)index;
  (void)out;
  return Status::Fail(kErrNoAudioTrack, "no audio track");
}

std::shared_ptr<DecodeSession> VideoEntry::StickySession() {
  std::lock_guard<std::mutex> lock(mu_);
  if (sticky_) {
    return sticky_;
  }
  auto acquired = DecoderPool::Instance().Acquire(id_);
  if (!acquired.ok() || !acquired.value) {
    return nullptr;
  }
  stickyDecoder_ = acquired.value;
  sticky_ = std::make_shared<DecodeSession>(id_, packets(), timeline(), cache_,
                                            stickyDecoder_);
  sticky_->SetGenerationSource([this] { return generation_.load(); });
  if (packets()) {
    sticky_->SetTrack(packets()->track());
  }
  return sticky_;
}

void VideoEntry::DropStickySession() {
  std::lock_guard<std::mutex> lock(mu_);
  sticky_.reset();
  if (stickyDecoder_) {
    DecoderPool::Instance().Release(id_);
    stickyDecoder_.reset();
    DecoderPool::Instance().CloseUnused(DecoderClass::Cpu, id_);
  }
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
