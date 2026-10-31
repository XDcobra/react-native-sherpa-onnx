#pragma once

#include <array>
#include <mutex>
#include <string>

#include "codec/CodecTypes.h"

namespace sherpa_onnx {
namespace codec {

RamClass ClassifyRam(int64_t totalBytes);
int TableLimit(RamClass ram, ResourceClass cls);
int SwDecodeThreadCap();
int FfmpegThreadCount();
int ClampBudget(int n);

/** Authoritative size / alignment / block / profile / bit-depth (D7). */
bool StreamFits(const ProviderCaps& caps, const StreamCaps& stream,
                std::string* why = nullptr);

class CodecCaps {
 public:
  static CodecCaps& Instance();

  void Init(int64_t totalRamBytes);
  void ApplyInstanceHints(const std::vector<Provider>& providers);
  Status SetOverride(ResourceClass cls, int n);
  void ClearOverrides();

  RamClass ramClass() const;
  int Limit(ResourceClass cls) const;
  const char* Source(ResourceClass cls) const;
  void Snapshot(std::array<SlotSnap, 6>* out) const;

  /** Host-test helper. */
  void ResetForTest();

 private:
  CodecCaps() = default;
  void RecomputeLocked();
  static int Index(ResourceClass cls);

  mutable std::mutex mu_;
  RamClass ram_ = RamClass::Mid;
  std::array<int, 6> table_{1, 1, 1, 1, 1, 1};
  std::array<int, 6> hints_{};
  std::array<int, 6> limits_{1, 1, 1, 1, 1, 1};
  std::array<bool, 6> overridden_{};
  bool inited_ = false;
};

}  // namespace codec
}  // namespace sherpa_onnx
