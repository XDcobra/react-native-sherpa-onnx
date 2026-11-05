# AudioBuffer host bench results (Bucket B baselines)

**Host:** macOS/Linux Release `audiobuffer_bench`.  
**RSS:** `getrusage` max RSS (normalized to bytes; Δ = after − before).  
**Note:** Shipped policies are *characterized*, not approved. Dual gate = wall **and** RSS. Spool may win on lossless even if slower.

| Suite | Wall ms | Samples/s | RSS Δ MiB | Disk MiB | Notes |
|-------|--------:|----------:|----------:|---------:|-------|
| `B_offline_ram` | 2.41717 | 216901942 | 2.03125 | 0 | n=524288 kind=ram |
| `B_offline_mmap` | 42.3534 | 148546745 | 48.0156 | 0 | n=6291456 kind=mmap; cold_xor_ms=28.154292 warm_xor_ms=27.459333 |
| `B_ring_append_drain` | 0.122416 | 3921056071 | 0 | 0 | windowSec=60.000000 dur=30.000000s chunk=320 drained=480000; no_spool |
| `B_spool_append` | 1.65575 | 289898837 | 0 | 1.82812 | windowSec=60.000000 dur=30.000000s chunk=320 drained=480000; disk_MiB=1.828125 |
| `B_spool_behind` | 0.132583 | 603395608 | 0 | 0.304688 | tiny_ring+spool drain_from_0 drained=80000; disk_MiB=0.304688 |
| `B_live_to_offline_transfer` | 0.393625 | 8129564941 | 0 | 0 | fullIfSpooled=1 kind=mmap n=3200000 |
| `B_live_to_offline_ring` | 0.011167 | 2865586101 | 0 | 0 | fullIfSpooled=0 kind=ram n=32000 |
| `C_ring_chunk_256` | 0.138709 | 3460482016 | 0 | 0 | windowSec=60.000000 dur=30.000000s chunk=256 drained=480000; no_spool |
| `C_ring_chunk_1600` | 0.075958 | 6319281708 | 0 | 0 | windowSec=60.000000 dur=30.000000s chunk=1600 drained=480000; no_spool |
| `C_ring_chunk_4800` | 0.048708 | 9854644000 | 0 | 0 | windowSec=60.000000 dur=30.000000s chunk=4800 drained=480000; no_spool |
| `C_ring_chunk_16000` | 0.045375 | 10578512396 | 0 | 0 | windowSec=60.000000 dur=30.000000s chunk=16000 drained=480000; no_spool |
| `C_int16_append` | 0.123958 | 3872279320 | 0 | 0 | 30s @16k chunk=320 (current convert+alloc path) |
| `C_resample_44k_to_16k` | 0.137542 | 3206293350 | 0 | 0 | 10s input @44.1k → live 16k (pa_resampleLinear) |

## Interpretation stubs (fill after reading numbers)

- **mmap vs RAM:** compare `B_offline_ram` vs `B_offline_mmap` wall + RSS Δ (mmap should not pin full file in RSS immediately; cold vs warm xor in extra).
- **Spool vs ring-only:** compare `B_ring_append_drain` vs `B_spool_append` wall and disk; label spool `lossless` if behind-ring works (`B_spool_behind`).
- **Transfer:** `B_live_to_offline_transfer` vs `B_live_to_offline_ring` — prefer transfer if kind=mmap and RSS stays bounded.
