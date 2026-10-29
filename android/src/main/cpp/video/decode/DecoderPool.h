#pragma once

#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

#include "decode/DecoderBackend.h"

namespace sherpa_onnx {
namespace video {

class DecoderPool {
 public:
  static DecoderPool& Instance();

  void SetMaxSessions(int n);
  void SetIdleCloseMs(int ms);
  int maxSessions() const;

  Result<std::shared_ptr<DecoderBackend>> Acquire(const std::string& bufferId,
                                                  int timeoutMs = 5000);
  void Release(const std::string& bufferId);
  void CloseIdle();
  void CloseAll();
  int activeCount() const;

 private:
  struct Slot {
    std::shared_ptr<DecoderBackend> decoder;
    int refs = 0;
    std::chrono::steady_clock::time_point lastRelease{};
  };

  DecoderPool() = default;
  void CloseIdleLocked();

  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::unordered_map<std::string, Slot> slots_;
  int maxSessions_ = 2;
  int idleCloseMs_ = 5000;
};

}  // namespace video
}  // namespace sherpa_onnx
