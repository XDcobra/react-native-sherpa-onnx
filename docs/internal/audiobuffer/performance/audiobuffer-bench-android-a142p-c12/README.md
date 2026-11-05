# A142P — post C #1/#2 cold pulls

- **Device:** Nothing A142P, `com.xdcobra.voicelab`
- **Code:** block-memcpy ring (`writeRingContiguous` / `readRingContiguous` in `PaLiveEntry.h`)
- **Protocol:** force-stop between suites (user-driven)

| Suite | loggedAt (+07) | Wall ms | RSS Δ | vs pre-C12 archive |
|-------|----------------|--------:|------:|--------------------|
| `B_ring_append_drain` | 10:00:20 | 4.09 | +144 KiB | was 7.96 ms / +292 KiB → **~1.94× wall**, RSS not worse |
| `B_offline_mmap` (isolated) | 10:00:51 | 180.69 | +180 KiB | was 161.48 ms / +144 KiB in multi-suite pull; **no ~48 MiB host-style create spike** |

Raw: `audiobuffer-bench-all.json`, `.ndjson`, `-latest.json`.
