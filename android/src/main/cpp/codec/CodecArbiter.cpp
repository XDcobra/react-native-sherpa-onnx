#include "codec/CodecArbiter.h"

#include "codec/CodecCaps.h"
#include "codec/CodecEvents.h"
#include "codec/CodecLog.h"

namespace sherpa_onnx {
namespace codec {
namespace {

std::string Key(ResourceClass cls, const std::string& owner) {
  return std::string(ResourceName(cls)) + ":" + owner;
}

}  // namespace

Lease::Lease(Lease&& other) noexcept
    : resource_(other.resource_),
      owner_(std::move(other.owner_)),
      owned_(other.owned_) {
  other.owned_ = false;
}

Lease& Lease::operator=(Lease&& other) noexcept {
  if (this != &other) {
    Reset();
    resource_ = other.resource_;
    owner_ = std::move(other.owner_);
    owned_ = other.owned_;
    other.owned_ = false;
  }
  return *this;
}

Lease::~Lease() { Reset(); }

void Lease::Reset() {
  if (owned_) {
    CodecArbiter::Instance().Release(resource_, owner_);
    owned_ = false;
  }
  owner_.clear();
}

CodecArbiter& CodecArbiter::Instance() {
  static CodecArbiter inst;
  return inst;
}

int CodecArbiter::Index(ResourceClass cls) { return static_cast<int>(cls); }

int CodecArbiter::InUseLocked(ResourceClass cls) const {
  int n = 0;
  for (const auto& kv : slots_) {
    if (kv.second.cls == cls && kv.second.refs > 0) ++n;
  }
  return n;
}

Result<Lease> CodecArbiter::TryAcquire(ResourceClass cls,
                                       const std::string& owner) {
  Result<Lease> r;
  if (owner.empty()) {
    r.status = Status::Fail(kErrCodecInvalidArgument, "owner empty");
    return r;
  }
  std::lock_guard<std::mutex> lock(mu_);
  const std::string key = Key(cls, owner);
  auto it = slots_.find(key);
  if (it != slots_.end()) {
    it->second.refs++;
    Lease lease;
    lease.resource_ = cls;
    lease.owner_ = owner;
    lease.owned_ = true;
    r.value = std::move(lease);
    return r;
  }
  const int max = CodecCaps::Instance().Limit(cls);
  const int inUse = InUseLocked(cls);
  if (inUse >= max) {
    r.status = Status::Fail("pool-full", "pool-full");
    CODEC_LOGI("codec.skip owner=%s provider=- reason=pool-full inUse=%d max=%d",
               owner.c_str(), inUse, max);
    return r;
  }
  Slot s;
  s.cls = cls;
  s.owner = owner;
  s.refs = 1;
  slots_[key] = s;
  CODEC_LOGI("codec.try owner=%s resource=%s", owner.c_str(), ResourceName(cls));
  Lease lease;
  lease.resource_ = cls;
  lease.owner_ = owner;
  lease.owned_ = true;
  r.value = std::move(lease);
  return r;
}

void CodecArbiter::Release(ResourceClass cls, const std::string& owner) {
  int inUseAfter = 0;
  int max = 1;
  bool dropped = false;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = slots_.find(Key(cls, owner));
    if (it == slots_.end()) return;
    if (it->second.refs > 0) it->second.refs--;
    if (it->second.refs == 0) {
      slots_.erase(it);
      dropped = true;
    }
    inUseAfter = InUseLocked(cls);
    max = CodecCaps::Instance().Limit(cls);
  }
  if (dropped) {
    CODEC_LOGI("codec.slot release resource=%s owner=%s inUse=%d max=%d",
               ResourceName(cls), owner.c_str(), inUseAfter, max);
    EmitSlotFreed(cls, max, inUseAfter);
  }
}

int CodecArbiter::InUse(ResourceClass cls) const {
  std::lock_guard<std::mutex> lock(mu_);
  return InUseLocked(cls);
}

int CodecArbiter::Max(ResourceClass cls) const {
  return CodecCaps::Instance().Limit(cls);
}

std::vector<SlotSnap> CodecArbiter::Snapshot() const {
  std::array<SlotSnap, 6> caps{};
  CodecCaps::Instance().Snapshot(&caps);
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<SlotSnap> out;
  out.reserve(6);
  for (int i = 0; i < 6; ++i) {
    SlotSnap s = caps[static_cast<size_t>(i)];
    s.inUse = InUseLocked(static_cast<ResourceClass>(i));
    out.push_back(s);
  }
  return out;
}

std::vector<std::string> CodecArbiter::Holders(ResourceClass cls) const {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<std::string> out;
  for (const auto& kv : slots_) {
    if (kv.second.cls == cls && kv.second.refs > 0) {
      out.push_back(kv.second.owner);
    }
  }
  return out;
}

void CodecArbiter::ResetForTest() {
  std::lock_guard<std::mutex> lock(mu_);
  slots_.clear();
}

}  // namespace codec
}  // namespace sherpa_onnx
