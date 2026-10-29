#include "VideoPacketReader.h"

#include "VideoRegistry.h"

namespace sherpa_onnx {
namespace video {

VideoPacketReader::VideoPacketReader(std::shared_ptr<VideoEntry> entry)
    : entry_(std::move(entry)) {}

const std::vector<uint8_t>& VideoPacketReader::codecConfig() const {
  static const std::vector<uint8_t> kEmpty;
  if (!entry_ || !entry_->packets()) {
    return kEmpty;
  }
  return entry_->packets()->track().codecConfig;
}

Status VideoPacketReader::SeekToKeyframe(int64_t tUs) {
  if (!entry_ || !entry_->timeline()) {
    return Status::Fail(kErrBufferNotFound, "reader");
  }
  const int64_t pres = entry_->timeline()->ClosestKeyframe(tUs);
  decodeIndex_ = entry_->timeline()->DecodeIndexOf(pres);
  eos_ = false;
  return Status::Ok();
}

Result<EncodedPacket> VideoPacketReader::Next(int timeoutMs) {
  Result<EncodedPacket> r;
  if (!entry_ || !entry_->packets()) {
    r.status = Status::Fail(kErrBufferNotFound, "reader");
    return r;
  }
  while (true) {
    auto st = entry_->packets()->ReadPacket(decodeIndex_, &r.value);
    if (st.ok) {
      ++decodeIndex_;
      return r;
    }
    auto live = std::dynamic_pointer_cast<LiveVideoEntry>(entry_);
    if (live && live->state() == VideoBufferState::Recording) {
      live->WaitAppend(timeoutMs);
      st = entry_->packets()->ReadPacket(decodeIndex_, &r.value);
      if (st.ok) {
        ++decodeIndex_;
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
