#include "core/Timeline.h"

#include <algorithm>
#include <limits>

namespace sherpa_onnx {
namespace video {

void Timeline::Reserve(size_t n) {
  std::lock_guard<std::mutex> lock(mu_);
  current_.reserve(std::min(n, kChunk));
}

void Timeline::Append(const SampleEntry& sample) {
  std::lock_guard<std::mutex> lock(mu_);
  if (immutable_) {
    return;
  }
  if (current_.size() >= kChunk) {
    chunks_.push_back(std::move(current_));
    current_.clear();
    current_.reserve(kChunk);
  }
  current_.push_back(sample);
  ++total_;
  ++generation_;
  decodeToPres_.clear();
}

void Timeline::AssignImmutable(std::vector<SampleEntry> presentationOrdered) {
  std::lock_guard<std::mutex> lock(mu_);
  chunks_.clear();
  current_ = std::move(presentationOrdered);
  total_ = current_.size();
  immutable_ = true;
  ++generation_;
  RebuildDecodeOrderLocked();
}

int64_t Timeline::frameCount() const {
  std::lock_guard<std::mutex> lock(mu_);
  return static_cast<int64_t>(total_);
}

uint64_t Timeline::generation() const {
  std::lock_guard<std::mutex> lock(mu_);
  return generation_;
}

Timeline::Snapshot Timeline::Snap() const {
  Snapshot s;
  s.generation = generation_;
  s.total = total_;
  s.chunks.reserve(chunks_.size() + 1);
  for (const auto& c : chunks_) {
    s.chunks.push_back(&c);
  }
  if (!current_.empty()) {
    s.chunks.push_back(&current_);
  }
  return s;
}

bool Timeline::GetAt(const Snapshot& snap, int64_t i, SampleEntry* out) const {
  if (i < 0 || static_cast<size_t>(i) >= snap.total || out == nullptr) {
    return false;
  }
  size_t remain = static_cast<size_t>(i);
  for (const auto* c : snap.chunks) {
    if (remain < c->size()) {
      *out = (*c)[remain];
      return true;
    }
    remain -= c->size();
  }
  return false;
}

Status Timeline::Get(int64_t presentationIndex, SampleEntry* out) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto snap = Snap();
  if (!GetAt(snap, presentationIndex, out)) {
    return Status::Fail(kErrFrameOutOfRange, "timeline index");
  }
  return Status::Ok();
}

int64_t Timeline::SampleAtPts(int64_t tUs) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto snap = Snap();
  if (snap.total == 0) {
    return -1;
  }
  SampleEntry first;
  GetAt(snap, 0, &first);
  if (tUs < first.ptsUs) {
    return 0;
  }
  int64_t lo = 0;
  int64_t hi = static_cast<int64_t>(snap.total) - 1;
  while (lo < hi) {
    const int64_t mid = lo + (hi - lo + 1) / 2;
    SampleEntry s;
    GetAt(snap, mid, &s);
    if (s.ptsUs <= tUs) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

int64_t Timeline::KeyframeAtOrBefore(int64_t sampleIdx) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto snap = Snap();
  if (snap.total == 0) {
    return -1;
  }
  int64_t i = sampleIdx;
  if (i < 0) {
    i = 0;
  }
  if (static_cast<size_t>(i) >= snap.total) {
    i = static_cast<int64_t>(snap.total) - 1;
  }
  for (; i >= 0; --i) {
    SampleEntry s;
    GetAt(snap, i, &s);
    if (s.flags & kSampleKey) {
      return i;
    }
  }
  return 0;
}

int64_t Timeline::ClosestKeyframe(int64_t tUs) const {
  const int64_t at = SampleAtPts(tUs);
  if (at < 0) {
    return -1;
  }
  const int64_t before = KeyframeAtOrBefore(at);
  SampleEntry kb;
  SampleEntry ka;
  int64_t after = -1;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto snap = Snap();
    for (int64_t i = at + 1; i < static_cast<int64_t>(snap.total); ++i) {
      SampleEntry s;
      GetAt(snap, i, &s);
      if (s.flags & kSampleKey) {
        after = i;
        ka = s;
        break;
      }
    }
    GetAt(snap, before, &kb);
  }
  if (after < 0) {
    return before;
  }
  SampleEntry cur;
  Get(at, &cur);
  const int64_t dBefore = std::llabs(tUs - kb.ptsUs);
  const int64_t dAfter = std::llabs(ka.ptsUs - tUs);
  return dAfter < dBefore ? after : before;
}

std::vector<int64_t> Timeline::KeyframeTimes(int64_t fromUs, int64_t toUs,
                                             size_t maxCount) const {
  std::vector<int64_t> out;
  std::lock_guard<std::mutex> lock(mu_);
  auto snap = Snap();
  for (int64_t i = 0; i < static_cast<int64_t>(snap.total); ++i) {
    SampleEntry s;
    GetAt(snap, i, &s);
    if ((s.flags & kSampleKey) == 0) {
      continue;
    }
    if (s.ptsUs < fromUs) {
      continue;
    }
    if (s.ptsUs > toUs) {
      break;
    }
    out.push_back(s.ptsUs);
    if (maxCount > 0 && out.size() >= maxCount) {
      break;
    }
  }
  return out;
}

int64_t Timeline::startUs() const {
  SampleEntry s;
  if (!Get(0, &s).ok) {
    return 0;
  }
  return s.ptsUs;
}

int64_t Timeline::endUs() const {
  std::lock_guard<std::mutex> lock(mu_);
  auto snap = Snap();
  if (snap.total == 0) {
    return 0;
  }
  SampleEntry last;
  GetAt(snap, static_cast<int64_t>(snap.total) - 1, &last);
  int64_t dur = 33333;
  if (snap.total >= 2) {
    SampleEntry prev;
    GetAt(snap, static_cast<int64_t>(snap.total) - 2, &prev);
    const int64_t d = last.ptsUs - prev.ptsUs;
    if (d > 0) {
      dur = d;
    }
  }
  return last.ptsUs + dur;
}

void Timeline::RebuildDecodeOrderLocked() {
  decodeToPres_.resize(total_);
  std::vector<int64_t> order(total_);
  for (size_t i = 0; i < total_; ++i) {
    order[i] = static_cast<int64_t>(i);
  }
  std::sort(order.begin(), order.end(), [&](int64_t a, int64_t b) {
    SampleEntry sa;
    SampleEntry sb;
    GetAt(Snap(), a, &sa);
    GetAt(Snap(), b, &sb);
    if (sa.dtsUs != sb.dtsUs) {
      return sa.dtsUs < sb.dtsUs;
    }
    return a < b;
  });
  for (size_t i = 0; i < order.size(); ++i) {
    decodeToPres_[i] = order[i];
  }
}

int64_t Timeline::PresentationOfDecode(int64_t decodeIndex) const {
  std::lock_guard<std::mutex> lock(mu_);
  if (decodeToPres_.size() != total_) {
    const_cast<Timeline*>(this)->RebuildDecodeOrderLocked();
  }
  if (decodeIndex < 0 || static_cast<size_t>(decodeIndex) >= decodeToPres_.size()) {
    return -1;
  }
  return decodeToPres_[static_cast<size_t>(decodeIndex)];
}

int64_t Timeline::DecodeIndexOf(int64_t presentationIndex) const {
  // Samples are stored presentation-ordered. Decode order follows dts.
  std::lock_guard<std::mutex> lock(mu_);
  auto snap = Snap();
  if (presentationIndex < 0 ||
      static_cast<size_t>(presentationIndex) >= snap.total) {
    return -1;
  }
  SampleEntry target;
  GetAt(snap, presentationIndex, &target);
  int64_t decode = 0;
  for (int64_t i = 0; i < static_cast<int64_t>(snap.total); ++i) {
    SampleEntry s;
    GetAt(snap, i, &s);
    if (s.dtsUs < target.dtsUs ||
        (s.dtsUs == target.dtsUs && i < presentationIndex)) {
      ++decode;
    }
  }
  return decode;
}

}  // namespace video
}  // namespace sherpa_onnx
