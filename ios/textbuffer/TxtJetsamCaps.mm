#import "TxtJetsamCaps.h"

#if TARGET_OS_IPHONE
#import <os/proc.h>
#endif

#include <TargetConditionals.h>
#include <algorithm>
#include <atomic>
#include <cstdint>

namespace {
/**
 * Perf keep: D-I3 Adaptive — clamp only when os_proc_available_memory() is known and low.
 * ForceTight is harness-only (proved ~28× less RSS Δ on sim flood). avail<=0 → no clamp.
 */
std::atomic<TxtJetsamCapsMode> g_mode{TxtJetsamCapsModeAdaptive};
std::atomic<int64_t> g_avail_override{-1};
}  // namespace

extern "C" void txt_ios_set_jetsam_caps_mode(TxtJetsamCapsMode mode) {
  g_mode.store(mode, std::memory_order_relaxed);
}

extern "C" TxtJetsamCapsMode txt_ios_get_jetsam_caps_mode(void) {
  return g_mode.load(std::memory_order_relaxed);
}

extern "C" void txt_ios_set_jetsam_avail_override_bytes(int64_t bytesOrNegative) {
  g_avail_override.store(bytesOrNegative, std::memory_order_relaxed);
}

extern "C" int64_t txt_ios_jetsam_avail_bytes(void) {
  const int64_t ov = g_avail_override.load(std::memory_order_relaxed);
  if (ov >= 0) return ov;
#if TARGET_OS_IPHONE
  if (@available(iOS 13.0, *)) {
    return static_cast<int64_t>(os_proc_available_memory());
  }
#endif
  // macOS host / Catalyst without Jetsam API: treat as unknown-high (no Adaptive clamp).
  return INT64_MAX;
}

extern "C" bool txt_ios_apply_jetsam_caps(int *windowMaxChars, int *maxSegments) {
  if (!windowMaxChars || !maxSegments) return false;
  const TxtJetsamCapsMode mode = g_mode.load(std::memory_order_relaxed);
  if (mode == TxtJetsamCapsModeOff) return false;

  int w = *windowMaxChars > 0 ? *windowMaxChars : 65536;
  int s = *maxSegments > 0 ? *maxSegments : 4096;
  const int w0 = w;
  const int s0 = s;

  int capW = w;
  int capS = s;
  if (mode == TxtJetsamCapsModeForceTight) {
    capW = 16384;
    capS = 512;
  } else {
    const int64_t avail = txt_ios_jetsam_avail_bytes();
    // avail<=0 → unknown (common on Simulator); do not clamp.
    if (avail <= 0) {
      return false;
    } else if (avail < 64LL * 1024 * 1024) {
      capW = 16384;
      capS = 512;
    } else if (avail < 256LL * 1024 * 1024) {
      capW = 32768;
      capS = 1024;
    } else if (avail < 512LL * 1024 * 1024) {
      capW = 65536;
      capS = 2048;
    }
  }

  w = std::min(w, capW);
  s = std::min(s, capS);
  *windowMaxChars = w;
  *maxSegments = s;
  return w != w0 || s != s0;
}
