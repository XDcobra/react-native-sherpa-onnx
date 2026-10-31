#include "live/EncodedPacketRing.h"

#include "VideoLog.h"

namespace sherpa_onnx {
namespace video {

void EncodedPacketRing::Configure(int64_t ringSeconds, int64_t ringMaxBytes) {
  std::lock_guard<std::mutex> lock(mu_);
  ringSeconds_ = ringSeconds > 0 ? ringSeconds : 10;
  ringMaxBytes_ = ringMaxBytes > 0 ? ringMaxBytes : 32LL * 1024 * 1024;
}

void EncodedPacketRing::Clear() {
  std::lock_guard<std::mutex> lock(mu_);
  packets_.clear();
  firstIndex_ = 0;
  bytes_ = 0;
  seenKey_ = false;
}

int64_t EncodedPacketRing::firstIndex() const {
  std::lock_guard<std::mutex> lock(mu_);
  return firstIndex_;
}

int64_t EncodedPacketRing::lastIndex() const {
  std::lock_guard<std::mutex> lock(mu_);
  if (packets_.empty()) {
    return firstIndex_ - 1;
  }
  return firstIndex_ + static_cast<int64_t>(packets_.size()) - 1;
}

int64_t EncodedPacketRing::byteSize() const {
  std::lock_guard<std::mutex> lock(mu_);
  return bytes_;
}

TimeRange EncodedPacketRing::rangeUs() const {
  std::lock_guard<std::mutex> lock(mu_);
  TimeRange r;
  if (packets_.empty()) {
    return r;
  }
  r.startUs = packets_.front().ptsUs;
  r.endUs = packets_.back().ptsUs;
  return r;
}

bool EncodedPacketRing::Contains(int64_t presentationIndex) const {
  std::lock_guard<std::mutex> lock(mu_);
  return presentationIndex >= firstIndex_ &&
         presentationIndex < firstIndex_ + static_cast<int64_t>(packets_.size());
}

Status EncodedPacketRing::Read(int64_t presentationIndex, EncodedPacket* out) const {
  std::lock_guard<std::mutex> lock(mu_);
  if (out == nullptr || presentationIndex < firstIndex_ ||
      presentationIndex >= firstIndex_ + static_cast<int64_t>(packets_.size())) {
    return Status::Fail(kErrFrameEvicted, "not in ring");
  }
  *out = packets_[static_cast<size_t>(presentationIndex - firstIndex_)];
  return Status::Ok();
}

void EncodedPacketRing::EvictLocked(int64_t keepSeconds, int64_t keepBytes) {
  if (packets_.empty()) {
    return;
  }
  auto over = [&]() {
    if (bytes_ > keepBytes) {
      return true;
    }
    const int64_t span = packets_.back().ptsUs - packets_.front().ptsUs;
    return span > keepSeconds * 1000000;
  };
  while (over() && packets_.size() > 1) {
    // Evict a whole GOP from the front (up to next key after the first).
    size_t end = 1;
    while (end < packets_.size() && (packets_[end].flags & kSampleKey) == 0) {
      ++end;
    }
    if (end >= packets_.size()) {
      // Would split the only remaining GOP — stop (never below one GOP).
      break;
    }
    for (size_t i = 0; i < end; ++i) {
      bytes_ -= static_cast<int64_t>(packets_[i].payload.size());
    }
    packets_.erase(packets_.begin(), packets_.begin() + static_cast<std::ptrdiff_t>(end));
    firstIndex_ += static_cast<int64_t>(end);
    evictedFrames_ += static_cast<int64_t>(end);
    VIDEO_LOGI("video.live ring evict gop frames=%zu bytes=%lld", end,
               static_cast<long long>(bytes_));
  }
}

void EncodedPacketRing::TrimToNewestGop() {
  std::lock_guard<std::mutex> lock(mu_);
  if (packets_.empty()) {
    return;
  }
  size_t lastKey = 0;
  for (size_t i = 0; i < packets_.size(); ++i) {
    if (packets_[i].flags & kSampleKey) {
      lastKey = i;
    }
  }
  if (lastKey == 0) {
    return;
  }
  for (size_t i = 0; i < lastKey; ++i) {
    bytes_ -= static_cast<int64_t>(packets_[i].payload.size());
  }
  evictedFrames_ += static_cast<int64_t>(lastKey);
  firstIndex_ += static_cast<int64_t>(lastKey);
  packets_.erase(packets_.begin(),
                 packets_.begin() + static_cast<std::ptrdiff_t>(lastKey));
}

Status EncodedPacketRing::Append(const EncodedPacket& pkt, Timeline* timeline) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!seenKey_) {
    if ((pkt.flags & kSampleKey) == 0) {
      ++droppedBeforeKey_;
      return Status::Ok();
    }
    seenKey_ = true;
  }
  packets_.push_back(pkt);
  bytes_ += static_cast<int64_t>(pkt.payload.size());
  if (timeline) {
    SampleEntry s;
    s.ptsUs = pkt.ptsUs;
    s.dtsUs = pkt.dtsUs;
    s.flags = pkt.flags;
    s.size = static_cast<uint32_t>(pkt.payload.size());
    timeline->Append(s);
  }
  EvictLocked(ringSeconds_, ringMaxBytes_);
  return Status::Ok();
}

}  // namespace video
}  // namespace sherpa_onnx
