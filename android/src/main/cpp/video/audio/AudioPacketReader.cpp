#include "audio/AudioPacketReader.h"

#include "VideoEntry.h"
#include "live/LiveVideoEntry.h"

namespace sherpa_onnx {
namespace video {

AudioPacketReader::AudioPacketReader(std::shared_ptr<VideoEntry> entry)
    : entry_(std::move(entry)) {}

const AudioTrackInfo* AudioPacketReader::track() const {
  return entry_ ? entry_->audioTrack() : nullptr;
}

Status AudioPacketReader::SeekTo(int64_t tUs) {
  if (!entry_ || !entry_->audioTimeline()) {
    return Status::Fail(kErrNoAudioTrack, "audio reader");
  }
  const int64_t at = entry_->audioTimeline()->IndexAtOrBefore(tUs);
  index_ = at <= 0 ? 0 : at - 1;
  eos_ = false;
  return Status::Ok();
}

Result<EncodedPacket> AudioPacketReader::Next(int timeoutMs) {
  Result<EncodedPacket> r;
  if (!entry_) {
    r.status = Status::Fail(kErrBufferNotFound, "audio reader");
    return r;
  }
  while (true) {
    auto st = entry_->ReadAudioPacket(index_, &r.value);
    if (st.ok) {
      ++index_;
      return r;
    }
    auto live = std::dynamic_pointer_cast<LiveVideoEntry>(entry_);
    if (live && live->state() == VideoBufferState::Recording) {
      live->WaitAppend(timeoutMs);
      st = entry_->ReadAudioPacket(index_, &r.value);
      if (st.ok) {
        ++index_;
        return r;
      }
      if (live->state() == VideoBufferState::Finished) {
        eos_ = true;
        r.status = Status::Fail(kErrCancelled, "EOS");
        return r;
      }
    }
    eos_ = true;
    r.status = st;
    return r;
  }
}

}  // namespace video
}  // namespace sherpa_onnx
