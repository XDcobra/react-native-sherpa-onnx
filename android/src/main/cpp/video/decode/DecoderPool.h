#pragma once

#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "decode/DecoderBackend.h"

namespace sherpa_onnx {
namespace video {

enum class DecoderClass { Cpu = 0, Display = 1 };

/**
 * Move-only RAII handle for a pooled decoder. Release happens in the
 * destructor (and on move-assignment). Idle close never runs while a slot
 * is held.
 */
class DecoderSlot {
 public:
  DecoderSlot() = default;
  DecoderSlot(DecoderSlot&& other) noexcept;
  DecoderSlot& operator=(DecoderSlot&& other) noexcept;
  ~DecoderSlot();

  DecoderSlot(const DecoderSlot&) = delete;
  DecoderSlot& operator=(const DecoderSlot&) = delete;

  explicit operator bool() const { return static_cast<bool>(decoder_); }
  DecoderBackend* get() const { return decoder_.get(); }
  const std::shared_ptr<DecoderBackend>& shared() const { return decoder_; }
  const std::string& ownerId() const { return ownerId_; }
  DecoderClass cls() const { return cls_; }

  void Reset();

 private:
  friend class DecoderPool;
  std::shared_ptr<DecoderBackend> decoder_;
  std::string ownerId_;
  DecoderClass cls_ = DecoderClass::Cpu;
  bool owned_ = false;
};

class DecoderPool {
 public:
  static DecoderPool& Instance();

  /** Default 1 per class (cpu + display = 2 HW sessions). Clamped to [1, 4]. */
  void SetMaxSessions(DecoderClass cls, int n);
  /** Backward-compat: set both classes to n. */
  void SetMaxSessions(int n);
  void SetIdleCloseMs(int ms);
  int maxSessions(DecoderClass cls) const;
  int maxSessions() const;  // cpu, for existing callers

  /**
   * Acquire (or re-enter) a decoder for ownerId in the given class.
   * Cpu waits up to timeoutMs when the class is full.
   * Display with timeoutMs <= 0 fails immediately with VIDEO_PREVIEW_DECODER_BUSY.
   */
  Result<DecoderSlot> AcquireSlot(DecoderClass cls, const std::string& ownerId,
                                  int timeoutMs = 0);

  /** Cpu class, waits up to timeoutMs. Existing OCR/image path. */
  Result<std::shared_ptr<DecoderBackend>> Acquire(const std::string& bufferId,
                                                  int timeoutMs = 5000);
  void Release(const std::string& bufferId);
  void ReleaseSlot(DecoderClass cls, const std::string& ownerId);

  void CloseIdle();
  void CloseAll();
  int activeCount() const;
  int activeCount(DecoderClass cls) const;
  /** Owner ids currently holding a slot of this class (refs > 0). */
  std::vector<std::string> Holders(DecoderClass cls) const;

 private:
  struct Slot {
    std::shared_ptr<DecoderBackend> decoder;
    DecoderClass cls = DecoderClass::Cpu;
    int refs = 0;
    std::chrono::steady_clock::time_point lastRelease{};
  };

  DecoderPool() = default;
  static std::string Key(DecoderClass cls, const std::string& ownerId);
  void CloseIdleLocked();
  int InUseLocked(DecoderClass cls) const;
  std::vector<std::string> HoldersLocked(DecoderClass cls) const;
  int& LimitOf(DecoderClass cls);

  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::unordered_map<std::string, Slot> slots_;
  int maxCpu_ = 1;
  int maxDisplay_ = 1;
  int idleCloseMs_ = 5000;
};

}  // namespace video
}  // namespace sherpa_onnx
