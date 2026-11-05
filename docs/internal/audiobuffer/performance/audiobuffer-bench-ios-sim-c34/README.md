# iOS Simulator — post C #1/#2 ring + C #4 (+ attempted JNI)

- **Device:** iPhone 17 Pro Simulator / iOS 26.3.1 — **ratios only**
- **Pulled:** 2026-11-05 ~03:10Z

| Suite | Result |
|-------|--------|
| `B_ring_append_drain` | wall **1.37 ms** (was 6.21 pre–C #1/#2 on sim) — confirms keep direction |
| `B_offline_mmap` | wall 100.7 ms, RSS Δ +160 KiB — no host-like +48 MiB |
| `C_int16_append` | wall **4.84 ms**, RSS Δ +80 KiB — portable #4 OK |
| `C_jni_float_append` | **skipped / failed** — Android JNI only (`ERR_AUDIO_BENCH_UNKNOWN_SUITE` in this pull; later builds return `skipped: android_jni_only`) |
| `C_jni_int16_append` | same — Android JNI only |

JNI buttons are hidden on iOS in the throwaway screen after the follow-up fix.
