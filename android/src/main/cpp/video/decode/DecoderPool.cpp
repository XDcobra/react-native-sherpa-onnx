#include "decode/DecoderPool.h"

#include "VideoLog.h"

namespace sherpa_onnx {
namespace video {

DecoderPool& DecoderPool::Instance() {
  static DecoderPool inst;
  return inst;
}

void DecoderPool::SetMaxSessions(int n) {
  std::lock_guard<std::mutex> lock(mu_);
  maxSessions_ = n < 1 ? 1 : n;
}

void DecoderPool::SetIdleCloseMs(int ms) {
  std::lock_guard<std::mutex> lock(mu_);
  idleCloseMs_ = ms < 0 ? 0 : ms;
}

int DecoderPool::maxSessions() const {
  std::lock_guard<std::mutex> lock(mu_);
  return maxSessions_;
}

int DecoderPool::activeCount() const {
  std::lock_guard<std::mutex> lock(mu_);
  return static_cast<int>(slots_.size());
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

Result<std::shared_ptr<DecoderBackend>> DecoderPool::Acquire(
    const std::string& bufferId, int timeoutMs) {
  std::unique_lock<std::mutex> lock(mu_);
  CloseIdleLocked();
  auto it = slots_.find(bufferId);
  if (it != slots_.end()) {
    it->second.refs++;
    Result<std::shared_ptr<DecoderBackend>> r;
    r.value = it->second.decoder;
    return r;
  }
  auto ready = [&]() {
    int inUse = 0;
    for (const auto& kv : slots_) {
      if (kv.second.refs > 0) {
        ++inUse;
      }
    }
    return inUse < maxSessions_;
  };
  if (!ready()) {
    if (timeoutMs <= 0) {
      Result<std::shared_ptr<DecoderBackend>> r;
      r.status = Status::Fail(kErrDecoderUnavailable, "decoder pool full");
      return r;
    }
    const bool ok = cv_.wait_for(lock, std::chrono::milliseconds(timeoutMs),
                                 ready);
    if (!ok) {
      Result<std::shared_ptr<DecoderBackend>> r;
      r.status = Status::Fail(kErrDecoderUnavailable, "decoder wait timeout");
      return r;
    }
  }
  Slot s;
  auto factory = GetDecoderFactory();
  s.decoder = factory();
  s.refs = 1;
  slots_[bufferId] = std::move(s);
  VIDEO_LOGI("video.decode acquire %s active=%zu", bufferId.c_str(),
             slots_.size());
  Result<std::shared_ptr<DecoderBackend>> r;
  r.value = slots_[bufferId].decoder;
  return r;
}

void DecoderPool::Release(const std::string& bufferId) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = slots_.find(bufferId);
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
