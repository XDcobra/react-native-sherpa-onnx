#include "audio/AudioTimeline.h"

#include "VideoLog.h"

#include <algorithm>

namespace sherpa_onnx {
namespace video {

void AudioTimeline::Reserve(size_t n) {
  std::lock_guard<std::mutex> lock(mu_);
  current_.reserve(std::min(n, kChunk));
}

void AudioTimeline::Append(const AudioPacketEntry& e) {
  std::lock_guard<std::mutex> lock(mu_);
  if (immutable_) {
    return;
  }
  if (!current_.empty() && e.ptsUs < current_.back().ptsUs && !ptsWarned_) {
    VIDEO_LOGW("video.audio pts went backwards %lld -> %lld",
               static_cast<long long>(current_.back().ptsUs),
               static_cast<long long>(e.ptsUs));
    ptsWarned_ = true;
  }
  if (current_.size() >= kChunk) {
    chunks_.push_back(std::move(current_));
    current_.clear();
    current_.reserve(kChunk);
  }
  current_.push_back(e);
  ++total_;
  ++generation_;
}

void AudioTimeline::AssignImmutable(std::vector<AudioPacketEntry> entries) {
  std::lock_guard<std::mutex> lock(mu_);
  chunks_.clear();
  current_ = std::move(entries);
  total_ = current_.size();
  firstIndex_ = 0;
  immutable_ = true;
  ++generation_;
}

void AudioTimeline::EvictBefore(int64_t index) {
  std::lock_guard<std::mutex> lock(mu_);
  if (immutable_ || index <= firstIndex_) {
    return;
  }
  const int64_t drop = index - firstIndex_;
  int64_t remain = drop;
  while (remain > 0 && !chunks_.empty()) {
    auto& c = chunks_.front();
    if (remain >= static_cast<int64_t>(c.size())) {
      remain -= static_cast<int64_t>(c.size());
      chunks_.erase(chunks_.begin());
    } else {
      c.erase(c.begin(), c.begin() + remain);
      remain = 0;
    }
  }
  if (remain > 0 && remain <= static_cast<int64_t>(current_.size())) {
    current_.erase(current_.begin(), current_.begin() + remain);
    remain = 0;
  }
  const int64_t actually = drop - remain;
  firstIndex_ += actually;
  total_ = total_ > static_cast<size_t>(actually)
               ? total_ - static_cast<size_t>(actually)
               : 0;
  ++generation_;
}

AudioTimeline::Snapshot AudioTimeline::Snap() const {
  Snapshot s;
  s.total = total_;
  s.first = firstIndex_;
  s.chunks.reserve(chunks_.size() + 1);
  for (const auto& c : chunks_) {
    s.chunks.push_back(&c);
  }
  if (!current_.empty()) {
    s.chunks.push_back(&current_);
  }
  return s;
}

bool AudioTimeline::GetAt(const Snapshot& snap, int64_t absIndex,
                          AudioPacketEntry* out) const {
  if (out == nullptr || absIndex < snap.first) {
    return false;
  }
  size_t remain = static_cast<size_t>(absIndex - snap.first);
  if (remain >= snap.total) {
    return false;
  }
  for (const auto* c : snap.chunks) {
    if (remain < c->size()) {
      *out = (*c)[remain];
      return true;
    }
    remain -= c->size();
  }
  return false;
}

Status AudioTimeline::Get(int64_t index, AudioPacketEntry* out) const {
  std::lock_guard<std::mutex> lock(mu_);
  if (!GetAt(Snap(), index, out)) {
    return Status::Fail(kErrFrameOutOfRange, "audio index");
  }
  return Status::Ok();
}

int64_t AudioTimeline::size() const {
  std::lock_guard<std::mutex> lock(mu_);
  return static_cast<int64_t>(total_);
}

uint64_t AudioTimeline::generation() const {
  std::lock_guard<std::mutex> lock(mu_);
  return generation_;
}

int64_t AudioTimeline::startUs() const {
  AudioPacketEntry e;
  std::lock_guard<std::mutex> lock(mu_);
  if (!GetAt(Snap(), firstIndex_, &e)) {
    return 0;
  }
  return e.ptsUs;
}

int64_t AudioTimeline::endUs() const {
  std::lock_guard<std::mutex> lock(mu_);
  auto snap = Snap();
  if (snap.total == 0) {
    return 0;
  }
  AudioPacketEntry e;
  if (!GetAt(snap, snap.first + static_cast<int64_t>(snap.total) - 1, &e)) {
    return 0;
  }
  return e.ptsUs + (e.durationUs > 0 ? e.durationUs : 0);
}

int64_t AudioTimeline::IndexAtOrBefore(int64_t tUs) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto snap = Snap();
  if (snap.total == 0) {
    return -1;
  }
  AudioPacketEntry first;
  if (!GetAt(snap, snap.first, &first) || tUs < first.ptsUs) {
    return -1;
  }
  int64_t lo = snap.first;
  int64_t hi = snap.first + static_cast<int64_t>(snap.total) - 1;
  while (lo < hi) {
    const int64_t mid = lo + (hi - lo + 1) / 2;
    AudioPacketEntry e;
    if (!GetAt(snap, mid, &e)) {
      break;
    }
    if (e.ptsUs <= tUs) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

}  // namespace video
}  // namespace sherpa_onnx
