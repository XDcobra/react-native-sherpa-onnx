# Live audio buffer: lock-free native ring buffer (future work)

**Status:** Future optimization note — not implemented.
**Scope:** Native live audio ring implementation on Android and iOS.

---

## Problem statement

The current live audio buffer uses a reader-writer lock on Android and a mutex on iOS to protect ring updates and ring reads. This is correct and easy to reason about, and it is not the cause of the streaming enhancement bug.

The remaining question is whether the ring itself should eventually be rewritten as a lock-free structure using atomics for the write head and read tail. That could reduce contention in very high concurrency scenarios, but it would not change the correctness model of the lossless spool-based pipeline.

---

## Why this is not part of the current fix

1. The hot path bottleneck is model inference, not the ring lock.
2. The current lock hold time is short and the buffer operations are already bounded.
3. A correct lock-free implementation is significantly harder to validate across platforms and architectures.
4. The lossless pipeline design already removes the real data-loss problem without requiring this optimization.

---

## Open questions

1. Is the real-world workload dominated by one producer and one or a few cursors, or by many concurrent native consumers?
2. Would a single-producer / multi-consumer design be enough, or do we need a more general MPMC ring?
3. Can the required memory ordering be tested reliably enough to justify the added complexity?

---

## Tentative direction

If this ever becomes necessary, the ring should be revisited as a separate performance project after the lossless spool pipeline has stabilized. A lock-free ring only makes sense if profiling shows lock contention is material in real workloads.