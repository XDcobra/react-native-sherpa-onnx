# Live audio buffer: mmap-backed spool for cursor reads (future work)

**Status:** Future optimization note — not implemented.
**Scope:** Native live audio spool reads and `createOfflineAudioBufferFromLive('fullIfSpooled')` / similar fast-path readers.

---

## Problem statement

The current lossless live audio pipeline uses a spool file as the authoritative store and a RAM ring as a short read cache. That design is correct, but the hot path still performs file I/O on every cursor read when a consumer falls behind the ring window.

For the current bug fix this is acceptable, because the spool read rate is low compared to inference. However, longer sessions and large retained spools will eventually make repeated `seek + read` style access a measurable cost, especially for native workers that drain many chunks in sequence.

The question to solve later is whether the live spool should be exposed through an mmap-backed reader so that behind-ring cursor reads become page-cache pointer access instead of explicit file reads.

---

## Why this is not part of the current fix

1. The enhancement speedup bug is solved by reading from the spool at all, not by mmap specifically.
2. Live spools are writable while consumers may read concurrently, so a simple one-shot mmap needs extra lifecycle handling.
3. Retention trimming is easier to reason about with a regular file reader first.

---

## Open questions

1. Should the live spool use a single growing mmap, remap-on-grow, or chunked mmap segments?
2. How should committed sample visibility be synchronized so readers never observe unwritten bytes?
3. Should `createOfflineAudioBufferFromLive('fullIfSpooled')` adopt the mmap region directly when the spool is finalized?

---

## Tentative direction

The likely best follow-up is chunked spool segmentation, where each segment is written once and then treated as a read-only mmap target. That avoids the complexity of remapping a growing file and matches the existing offline mmap model more closely.
