# TextBuffer host bench results (Bucket B baselines)

**Host:** macOS/Linux Release `textbuffer_bench` (shared `TextBufferBench.cpp`).  
**RSS:** process resident (`mach_task_basic_info` / `/proc/self/statm`).  
**Note:** Shipped policies are *characterized*, not approved. Dual gate = wall **and** RSS.

**Fixture:** Host uses **30 s @ 20 Hz = 600** `writePartial` ops (as-fast-as-possible). Device smokes later use longer `durationSec`.

| Suite | Wall ms | Ops/s | RSS Δ MiB | Disk MiB | Notes |
|-------|--------:|------:|----------:|---------:|-------|
| `B_live_partial_nospool` | 0.121875 | 4923076 | 0.015625 | 0 | ops=600 (20Hz×30.0000s) chars≈80–200 utf8; spool=off |
| `B_live_partial_spool` | 28.6268 | 20959 | 0.140625 | 0.0138559 | ops=600 (20Hz×30.0000s) chars≈80–200 utf8; journal+ckpt disk |
| `B_live_commit_storm` | 1.441 | 1387925 | 0.390625 | 0 | N=2000 small token/ts; B baseline |
| `B_spool_replay` | 1.61617 | 618 | 0 | 0.0176077 | fillOps=120 reconLen=199; snapshot+fullIfSpooled |
| `B_utf16_slice` | 0.557 | 359066 | 0.03125 | 0 | iters=200 mid utf16 start=500 max=2048; slice=0.5570ms full=0.2432ms ratio=2.2906 sink=431000/10240000 |
| `B_offline_populate_ocr` | 0.034375 | 29090 | 0.390625 | 0 | text=102400B spans=2000; B baseline |
| `C_spool_delta_b_fixture` | 30.829 | 19462 | 0.015625 | 0.0140743 | ops=600 writePartial B-fixture; C1 delta; parity=ok |
| `C_spool_delta_grow` | 23.786 | 25224 | 0.46875 | 0.00250435 | ops=600 append grow; C1 delta; parity=ok |
| `C_spool_fflush_b_fixture` | 17.371 | 34540 | 0 | 0.0140743 | ops=600 writePartial B-fixture; C3 deferred fflush 64KiB/32; parity=ok |
| `C_spool_fflush_grow` | 15.4514 | 38831 | 0.0625 | 0.00250435 | ops=600 append grow; C3 deferred fflush 64KiB/32; parity=ok |
| `C_spool_checkpoint_grow` | 202.92 | 29568 | -1.14062 | 0.0131702 | ops=6000 append grow C2 ckpt 128/1MiB; journalPre=1980 ckptPre=11794; replayMs=0.240583; parity=ok; journalBound=ok |
| `C_commit_copies` | 1.60192 | 1248504 | 0.359375 | 0 | N=2000 small token/ts; C12 skip spool snap when off |
| `C_spool_unlock` | 73.8858 | 8120 | -0.125 | 0.0140743 | ops=600 writePartial+spool + snapshot reader; hits=893343; C4 stateMutex unlock before spool I/O; parity=ok |
| `C_registry_unlock_populate` | 0.6475 | 1544 | 0.390625 | 0 | text=102400B spans=2000; C5 short g_txt_mutex around populate |
| `C_registry_unlock_multilive` | 3.02429 | 198393 | -0.03125 | 0 | buffers=8 opsPerBuf=75 lookups=128272; C5 multilive + get_live_entry noise |
| `C_utf16_len` | 0.428458 | 1400370 | 0 | 0 | ops=600 (20Hz×30.0000s) chars≈80–200 utf8; spool=off; C8 reuse utf16 len cache |
| `C_crc_optional_b_fixture` | 18.5654 | 32318 | 0 | 0.0140743 | ops=600 writePartial B-fixture; C14 hot journal checksum=0; ckpt/finalize crc; parity=ok |
| `C_crc_optional_grow` | 19.4416 | 30861 | 0.09375 | 0.00250435 | ops=600 append grow; C14 hot journal checksum=0; ckpt/finalize crc; parity=ok |
| `C_spool_replay_long` | 0.43675 | 2289 | 0.03125 | 0.0131359 | ops=6000 fill=C2-grow; replay=snapshotFullTextIfSpooled only; reconLen=12000 journal=1980 ckpt=11794; parity=ok |
| `C_listener_unlock_partial` | 0.252584 | 2375447 | 0 | 0 | ops=600 listeners=8 appendHits=0; C6 nospool writePartial (notify on commit/finalize only) |
| `C_listener_unlock_commit` | 0.579708 | 862503 | 0.078125 | 0 | N=500 listeners=8 appendHits=4000 commitHits=4000; C6 unlock-before notify + nested get_live_entry; parity=ok |

## How to run

```bash
cmake -S test/cpp/textbuffer -B test/cpp/textbuffer/build -DCMAKE_BUILD_TYPE=Release
cmake --build test/cpp/textbuffer/build --target textbuffer_bench -j
./test/cpp/textbuffer/build/textbuffer_bench \
  --out docs/internal/textbuffer/performance/textbuffer-host-bench-results.md
```

Correctness: `textbuffer_host_test` (spool opt-in: `SHERPA_HOST_TEXT_SPOOL=1`).
