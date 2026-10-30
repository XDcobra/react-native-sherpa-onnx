#include "live/AudioPacketRing.h"

namespace sherpa_onnx {
namespace video {

void AudioPacketRing::Configure(int64_t ringSeconds, int64_t ringMaxBytes) {
  std::lock_guard<std::mutex> lock(mu_);
  ringSeconds_ = ringSeconds > 0 ? ringSeconds : 10;
  ringMaxBytes_ = ringMaxBytes > 0 ? ringMaxBytes : 8LL * 1024 * 1024;
}

void AudioPacketRing::Clear() {
  std::lock_guard<std::mutex> lock(mu_);
  packets_.clear();
  firstIndex_ = 0;
  bytes_ = 0;
}

int64_t AudioPacketRing::firstIndex() const {
  std::lock_guard<std::mutex> lock(mu_);
  return firstIndex_;
}

int64_t AudioPacketRing::lastIndex() const {
  std::lock_guard<std::mutex> lock(mu_);
  if (packets_.empty()) return firstIndex_ - 1;
  return firstIndex_ + static_cast<int64_t>(packets_.size()) - 1;
}

TimeRange AudioPacketRing::rangeUs() const {
  std::lock_guard<std::mutex> lock(mu_);
  TimeRange r;
  if (packets_.empty()) return r;
  r.startUs = packets_.front().ptsUs;
  r.endUs = packets_.back().ptsUs;
  return r;
}

bool AudioPacketRing::Contains(int64_t index) const {
  std::lock_guard<std::mutex> lock(mu_);
  return index >= firstIndex_ &&
         index < firstIndex_ + static_cast<int64_t>(packets_.size());
}

Status AudioPacketRing::Read(int64_t index, EncodedPacket* out) const {
  std::lock_guard<std::mutex> lock(mu_);
  if (out == nullptr || index < firstIndex_ ||
      index >= firstIndex_ + static_cast<int64_t>(packets_.size())) {
    return Status::Fail(kErrFrameEvicted, "audio not in ring");
  }
  *out = packets_[static_cast<size_t>(index - firstIndex_)];
  return Status::Ok();
}

Status AudioPacketRing::Append(const EncodedPacket& pkt, AudioTimeline* timeline) {
  std::lock_guard<std::mutex> lock(mu_);
  packets_.push_back(pkt);
  bytes_ += static_cast<int64_t>(pkt.payload.size());
  if (timeline) {
    AudioPacketEntry e;
    e.ptsUs = pkt.ptsUs;
    e.size = static_cast<uint32_t>(pkt.payload.size());
    timeline->Append(e);
  }
  while (!packets_.empty()) {
    const int64_t span = packets_.back().ptsUs - packets_.front().ptsUs;
    if (bytes_ <= ringMaxBytes_ && span <= ringSeconds_ * 1000000) break;
    bytes_ -= static_cast<int64_t>(packets_.front().payload.size());
    packets_.erase(packets_.begin());
    ++firstIndex_;
  }
  return Status::Ok();
}

void AudioPacketRing::EvictBefore(int64_t keepStartUs) {
  std::lock_guard<std::mutex> lock(mu_);
  while (!packets_.empty() && packets_.front().ptsUs < keepStartUs) {
    bytes_ -= static_cast<int64_t>(packets_.front().payload.size());
    packets_.erase(packets_.begin());
    ++firstIndex_;
  }
}

}  // namespace video
}  // namespace sherpa_onnx
