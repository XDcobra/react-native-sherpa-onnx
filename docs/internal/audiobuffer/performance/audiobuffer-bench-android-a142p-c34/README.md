# A142P — C #3 / #4 cold pulls

- **Device:** Nothing A142P
- **Pulled:** 2026-11-05 ~10:08+07

| Suite | loggedAt (+07) | Wall ms | RSS Δ | Notes |
|-------|----------------|--------:|------:|-------|
| `C_int16_append` | 10:07:13 | 5.39 | 0 | portable C #4 chunked convert |
| `C_jni_float_append` | 10:07:49 | 8.06 | +1.34 MiB | D-A1 / C #3 Critical float |
| `C_jni_int16_append` | 10:08:24 | 11.39 | +1.45 MiB | JNI int16 + C #4 |

Also retains prior C #1/#2 cold rows in `all.json` (`B_ring` 4.09 ms, isolated `B_offline_mmap` 180.7 ms).
