#pragma once

/**
 * D-I3: Jetsam-aware clamps for live text windowMaxChars / maxSegments (iOS 13+).
 * Fallback = fixed caller defaults when mode is Off.
 */

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  /** Off: honor requested caps (harness A/B). */
  TxtJetsamCapsModeOff = 0,
  /** Clamp from os_proc_available_memory() (or bench override). */
  TxtJetsamCapsModeAdaptive = 1,
  /** Bench: always apply tight caps (simulates Jetsam pressure). */
  TxtJetsamCapsModeForceTight = 2,
} TxtJetsamCapsMode;

void txt_ios_set_jetsam_caps_mode(TxtJetsamCapsMode mode);
TxtJetsamCapsMode txt_ios_get_jetsam_caps_mode(void);

/** Bench only: override available bytes (−1 = use os_proc_available_memory). */
void txt_ios_set_jetsam_avail_override_bytes(int64_t bytesOrNegative);
int64_t txt_ios_jetsam_avail_bytes(void);

/**
 * Clamp requested caps in-place. No-op when mode is Off.
 * Returns true if either value changed.
 */
bool txt_ios_apply_jetsam_caps(int *windowMaxChars, int *maxSegments);

#ifdef __cplusplus
}  // extern "C"
#endif
