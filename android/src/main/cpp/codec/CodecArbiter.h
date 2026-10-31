#pragma once

#include <array>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "codec/CodecTypes.h"

namespace sherpa_onnx {
namespace codec {

class CodecArbiter;

/** Move-only RAII lease. Release happens in the destructor. */
class Lease {
 public:
  Lease() = default;
  Lease(Lease&& other) noexcept;
  Lease& operator=(Lease&& other) noexcept;
  ~Lease();

  Lease(const Lease&) = delete;
  Lease& operator=(const Lease&) = delete;

  explicit operator bool() const { return owned_; }
  ResourceClass resource() const { return resource_; }
  const std::string& owner() const { return owner_; }
  void Reset();

 private:
  friend class CodecArbiter;
  ResourceClass resource_ = ResourceClass::HwVideoDecodeCpu;
  std::string owner_;
  bool owned_ = false;
};

class CodecArbiter {
 public:
  static CodecArbiter& Instance();

  Result<Lease> TryAcquire(ResourceClass cls, const std::string& owner);
  void Release(ResourceClass cls, const std::string& owner);

  int InUse(ResourceClass cls) const;
  int Max(ResourceClass cls) const;
  std::vector<SlotSnap> Snapshot() const;
  std::vector<std::string> Holders(ResourceClass cls) const;

  void ResetForTest();

 private:
  CodecArbiter() = default;
  struct Slot {
    ResourceClass cls = ResourceClass::HwVideoDecodeCpu;
    std::string owner;
    int refs = 0;
  };
  static int Index(ResourceClass cls);
  int InUseLocked(ResourceClass cls) const;

  mutable std::mutex mu_;
  std::unordered_map<std::string, Slot> slots_;
};

}  // namespace codec
}  // namespace sherpa_onnx
