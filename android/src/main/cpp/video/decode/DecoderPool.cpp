#include "decode/DecoderPool.h"

#include "VideoLog.h"

namespace sherpa_onnx {
namespace video {

namespace {

int ClampLimit(int n) {
  if (n < 1) return 1;
  if (n > 4) return 4;
  return n;
}

}  // namespace

DecoderSlot::DecoderSlot(DecoderSlot&& other) noexcept
    : decoder_(std::move(other.decoder_)),
      ownerId_(std::move(other.ownerId_)),
      cls_(other.cls_),
      owned_(other.owned_) {
  other.owned_ = false;
  other.decoder_.reset();
}

DecoderSlot& DecoderSlot::operator=(DecoderSlot&& other) noexcept {
  if (this != &other) {
    Reset();
    decoder_ = std::move(other.decoder_);
    ownerId_ = std::move(other.ownerId_);
    cls_ = other.cls_;
    owned_ = other.owned_;
    other.owned_ = false;
    other.decoder_.reset();
  }
  return *this;
}

DecoderSlot::~DecoderSlot() { Reset(); }

void DecoderSlot::Reset() {
  if (owned_) {
    DecoderPool::Instance().ReleaseSlot(cls_, ownerId_);
    owned_ = false;
  }
  decoder_.reset();
  ownerId_.clear();
}

DecoderPool& DecoderPool::Instance() {
  static DecoderPool inst;
  return inst;
}

std::string DecoderPool::Key(DecoderClass cls, const std::string& ownerId) {
  return (cls == DecoderClass::Display ? "d:" : "c:") + ownerId;
}

int& DecoderPool::LimitOf(DecoderClass cls) {
  return cls == DecoderClass::Display ? maxDisplay_ : maxCpu_;
}

void DecoderPool::SetMaxSessions(DecoderClass cls, int n) {
  std::lock_guard<std::mutex> lock(mu_);
  LimitOf(cls) = ClampLimit(n);
  cv_.notify_all();
}

void DecoderPool::SetMaxSessions(int n) {
  std::lock_guard<std::mutex> lock(mu_);
  maxCpu_ = ClampLimit(n);
  maxDisplay_ = ClampLimit(n);
  cv_.notify_all();
}

void DecoderPool::SetIdleCloseMs(int ms) {
  std::lock_guard<std::mutex> lock(mu_);
  idleCloseMs_ = ms < 0 ? 0 : ms;
}

int DecoderPool::maxSessions(DecoderClass cls) const {
  std::lock_guard<std::mutex> lock(mu_);
  return cls == DecoderClass::Display ? maxDisplay_ : maxCpu_;
}

int DecoderPool::maxSessions() const {
  return maxSessions(DecoderClass::Cpu);
}

int DecoderPool::activeCount() const {
  std::lock_guard<std::mutex> lock(mu_);
  return static_cast<int>(slots_.size());
}

int DecoderPool::activeCount(DecoderClass cls) const {
  std::lock_guard<std::mutex> lock(mu_);
  return InUseLocked(cls);
}

int DecoderPool::InUseLocked(DecoderClass cls) const {
  int n = 0;
  for (const auto& kv : slots_) {
    if (kv.second.cls == cls && kv.second.refs > 0) {
      ++n;
    }
  }
  return n;
}

std::vector<std::string> DecoderPool::Holders(DecoderClass cls) const {
  std::lock_guard<std::mutex> lock(mu_);
  return HoldersLocked(cls);
}

std::vector<std::string> DecoderPool::HoldersLocked(DecoderClass cls) const {
  std::vector<std::string> out;
  for (const auto& kv : slots_) {
    if (kv.second.cls == cls && kv.second.refs > 0) {
      out.push_back(kv.first.size() > 2 ? kv.first.substr(2) : kv.first);
    }
  }
  return out;
}

void DecoderPool::CloseIdle() {
  std::lock_guard<std::mutex> lock(mu_);
  CloseIdleLocked();
}

void DecoderPool::CloseIdleLocked() {
  const auto now = std::chrono::steady_clock::now();
  for (auto it = slots_.begin(); it != slots_.end();) {
    if (it->second.refs == 0) {
      const auto idle = std::chrono::duration_cast<std::chrono::milliseconds>(
                            now - it->second.lastRelease)
                            .count();
      if (idleCloseMs_ == 0 || idle >= idleCloseMs_) {
        VIDEO_LOGI("video.decode idle close %s", it->first.c_str());
        if (it->second.decoder) {
          it->second.decoder->Close();
        }
        it = slots_.erase(it);
        continue;
      }
    }
    ++it;
  }
}

void DecoderPool::CloseAll() {
  std::lock_guard<std::mutex> lock(mu_);
  for (auto& kv : slots_) {
    if (kv.second.decoder) {
      kv.second.decoder->Close();
    }
  }
  slots_.clear();
  cv_.notify_all();
}

Result<DecoderSlot> DecoderPool::AcquireSlot(DecoderClass cls,
                                             const std::string& ownerId,
                                             int timeoutMs) {
  Result<DecoderSlot> r;
  if (ownerId.empty()) {
    r.status = Status::Fail(kErrInvalidArgument, "decoder owner id empty");
    return r;
  }
  std::unique_lock<std::mutex> lock(mu_);
  CloseIdleLocked();
  const std::string key = Key(cls, ownerId);
  auto it = slots_.find(key);
  if (it != slots_.end()) {
    it->second.refs++;
    DecoderSlot slot;
    slot.decoder_ = it->second.decoder;
    slot.ownerId_ = ownerId;
    slot.cls_ = cls;
    slot.owned_ = true;
    r.value = std::move(slot);
    return r;
  }
  auto ready = [&]() { return InUseLocked(cls) < LimitOf(cls); };
  if (!ready()) {
    if (timeoutMs <= 0) {
      std::string holders;
      for (const auto& h : HoldersLocked(cls)) {
        if (!holders.empty()) holders += ",";
        holders += h;
      }
      const char* code = cls == DecoderClass::Display ? kErrPreviewDecoderBusy
                                                      : kErrDecoderUnavailable;
      r.status = Status::Fail(
          code, std::string(cls == DecoderClass::Display
                                ? "display decoder busy holders="
                                : "decoder pool full holders=") +
                    holders);
      return r;
    }
    const bool ok =
        cv_.wait_for(lock, std::chrono::milliseconds(timeoutMs), ready);
    if (!ok) {
      r.status = Status::Fail(kErrDecoderUnavailable, "decoder wait timeout");
      return r;
    }
  }
  Slot s;
  s.cls = cls;
  auto factory = GetDecoderFactory();
  s.decoder = factory();
  s.refs = 1;
  slots_[key] = std::move(s);
  VIDEO_LOGI("video.decode acquire class=%d owner=%s activeCpu=%d activeDisp=%d",
             static_cast<int>(cls), ownerId.c_str(),
             InUseLocked(DecoderClass::Cpu),
             InUseLocked(DecoderClass::Display));
  DecoderSlot slot;
  slot.decoder_ = slots_[key].decoder;
  slot.ownerId_ = ownerId;
  slot.cls_ = cls;
  slot.owned_ = true;
  r.value = std::move(slot);
  return r;
}

Result<std::shared_ptr<DecoderBackend>> DecoderPool::Acquire(
    const std::string& bufferId, int timeoutMs) {
  auto slot = AcquireSlot(DecoderClass::Cpu, bufferId, timeoutMs);
  Result<std::shared_ptr<DecoderBackend>> r;
  r.status = slot.status;
  if (slot.ok() && slot.value) {
    r.value = slot.value.shared();
    // Detach RAII so the existing Release(bufferId) path owns the refcount.
    slot.value.owned_ = false;
  }
  return r;
}

void DecoderPool::Release(const std::string& bufferId) {
  ReleaseSlot(DecoderClass::Cpu, bufferId);
}

void DecoderPool::ReleaseSlot(DecoderClass cls, const std::string& ownerId) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = slots_.find(Key(cls, ownerId));
  if (it == slots_.end()) {
    return;
  }
  if (it->second.refs > 0) {
    it->second.refs--;
  }
  it->second.lastRelease = std::chrono::steady_clock::now();
  cv_.notify_all();
}

}  // namespace video
}  // namespace sherpa_onnx
