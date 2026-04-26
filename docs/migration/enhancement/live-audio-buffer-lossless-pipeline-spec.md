# Lossless LiveAudioBuffer Pipeline — Implementation Spec

**Status:** Specification (implementation pending).  
**Depends on / related:** 
- `docs/migration/enhancement/streaming-enhancement-speedup-analysis.md` (problem analysis)
- `docs/migration/audiobuffer/live-ingest-mandatory-spool-implementation-plan.md` (temporary spool on file ingest — already implemented)
- `docs/migration/mmap/spool-format-migration-spec.md` (F32-only WAV spool — in flight)

**Breaking changes:** Yes — SDK is pre-release.  
**Scope:** Any feature that consumes a `LiveAudioBuffer` via native cursor — currently Streaming Enhancement and Streaming STT; future features automatically inherit.

---

## 0. Problem recap (one paragraph)

The streaming Enhancement output is too short and speeds up after the first seconds because the input `LiveAudioBuffer` is a ring-only read surface: `ingestFileToLiveAudioBuffer` decodes at ~50–200× realtime while the Enhancement worker consumes at ~1× realtime; the ring wraps, the consumer cursor is silently snapped forward to the oldest ring position, and large continuous chunks of the input are never seen by the worker. The same structural problem hits every current and future feature that reads a `LiveAudioBuffer` through a cursor — including Streaming STT with file input. The already-present temporary spool catches the full data on disk but is **not** consulted on the streaming read path.

Full diagnosis in `streaming-enhancement-speedup-analysis.md`.

---

## 1. Goals

A single generic, robust design that:

1. **Preserves all producer data by default.** No silent drop for any feature, any producer.
2. **Is producer-agnostic.** Mic, file ingest, offline-append, JS append, and future producers share one contract.
3. **Is feature-agnostic.** Enhancement, STT, Alignment, TTS-input, and any future consumer use the same read path.
4. **Remains bounded in memory.** Ring stays capped (e.g. 60 s). Long sessions don't require hundreds of MB of RAM.
5. **Surfaces pathological cases explicitly.** A consumer that falls irrecoverably behind gets a typed error instead of silently corrupted audio.
6. **Keeps the hot path fast.** Zero disk I/O in steady state when the consumer keeps up.

### Non-goals

- Infinite-lag support. A retention cap is fine — the cap just has to be configurable and explicit.
- Replacing the LiveAudioBuffer primitive with per-feature File APIs (rejected in the previous discussion).

---

## 2. Design: "Spool is authoritative, ring is a read cache"

### 2.1 One data model, two access speeds

Today the `LiveEntry` / `PaLiveEntry` treats the ring as the authoritative store and the spool as a secondary archive. This is the root cause of the bug: the authoritative store has rolling eviction while the consumer read path isn't allowed to rewind.

The new model inverts that relationship:

```
Producer  ─ appendSamples ─►  ┌─────────────────────┐
                              │  Spool  (on disk)   │ ← authoritative store
                              │  append-only f32    │
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │  Ring cache (RAM)   │ ← recent tail only
                              │  windowCapacity     │
                              └──────────┬──────────┘
                                         │
Consumer ◄─── drainCursor  ──────────────┘
   - reads from ring if cursor within window
   - reads from spool if cursor behind window
   - never silently snaps forward
```

Both ring and spool are updated on every append. The ring is populated by the most recent writes and acts as a zero-I/O fast path. The spool holds **every** appended sample from the buffer's creation up to retention cap.

### 2.2 Consequences for the producer

- **Producers never block by default.** They append into ring + spool and return. Identical code path for mic, file ingest, JS append, offline append.
- **An opt-in `backpressure: 'block'` mode** is provided for deterministic producers (file ingest, offline append). This is a **pure disk-usage optimization**, not a correctness requirement. When enabled, the append waits until the slowest consumer cursor has room, so the spool file never grows much past what's being consumed.
- Mic always uses `backpressure: 'none'` because the microphone can't be throttled in the real world.

### 2.3 Consequences for the consumer

- **Cursor reads in order, always.** No snap-forward.
- If `cursor.absoluteReadPos` is inside the ring window → read from RAM.
- Else → read from the spool file at the corresponding byte offset.
- If spool retention has been trimmed past the cursor's position → typed error `CURSOR_LAG_EXCEEDED` on the read. Feature worker surfaces this as a pipeline error (via `StreamingPipelineCompletion.reason = 'error'`).

### 2.4 Consequences for retention

Current behavior: spool grows unbounded (if active) or doesn't exist at all.  
New behavior: spool retention is **policy-configurable** per buffer:

| Mode | Meaning | Typical use |
|---|---|---|
| `auto` (default) | Spool exists. Retention = max(`ringSeconds`, max cursor lag). Grows only as far behind as the slowest consumer needs. | Most features. Memory-safe, lossless, minimal disk. |
| `session` | Spool exists. Retention = entire session (no trimming). | Offline export via `createOfflineAudioBufferFromLive('fullIfSpooled')`. |
| `maxSeconds: N` | Spool exists. Retention = `N` seconds. Consumer that lags more than `N` seconds → `CURSOR_LAG_EXCEEDED`. | Long-running mic with a consumer that might stall. |
| `none` | No spool. Ring is authoritative (today's behavior). Consumer behind ring → `CURSOR_LAG_EXCEEDED`. | Tight embedded scenarios where disk I/O is not allowed. |

Importantly: `none` is the **only** mode that can lose data, and when it does, the consumer is **informed via error** instead of receiving sped-up audio.

### 2.5 Explicit matrix: producer × consumer

| Producer | Consumer fast enough | Consumer slow / stalled |
|---|---|---|
| Mic | Ring-only reads, zero I/O, fastest path | Cursor reads from spool; catches up when possible; `CURSOR_LAG_EXCEEDED` only if retention cap hit |
| File ingest (`backpressure: 'block'`, default) | Ingest runs decoder-fast until ring warms, then naturally slows to consumer pace; spool stays small | Same — decoder is coupled to consumer |
| File ingest (`backpressure: 'none'`) | Ingest runs at decoder speed; spool holds all data; consumer eventually finishes reading from spool | Same, just longer spool file |
| JS `appendSamples` | Ring-only reads | Same as mic |
| `appendOfflineToLiveAudioBuffer` | — | — (bulk append; natural block via default) |

In every row, **no data is lost silently.** That's the core invariant.

---

## 3. Public API (TypeScript)

Breaking changes; designed for a pre-release SDK.

### 3.1 Create buffer

```ts
export interface CreateEmptyLiveAudioBufferOptions {
  sampleRate: number;
  channelCount?: number; // default 1

  /**
   * Duration of the in-memory fast-path cache. Samples older than this may
   * still be readable via the spool, but don't count against RAM.
   * Default: 60.
   */
  ringSeconds?: number;

  /**
   * Controls on-disk retention of appended samples.
   * Default: 'auto'.
   *
   *  - 'auto'          : spool exists; trimmed to max(ringSeconds, slowest cursor lag).
   *  - 'session'       : spool retains every sample until buffer release.
   *  - { maxSeconds }  : spool retains up to N seconds; cursor beyond → error.
   *  - 'none'          : no spool; ring-only; lossless only if consumer never lags.
   *  - { path }        : explicit persistence path (replaces today's persistencePath).
   *
   * Short form `'auto'` | `'session'` | `'none'` implies auto-generated temp path.
   */
  retention?:
    | 'auto'
    | 'session'
    | 'none'
    | { mode: 'maxSeconds'; seconds: number; path?: string }
    | { mode: 'path'; path: string; trim?: 'auto' | 'session' | { maxSeconds: number } };

  streamEvents?: { framesAppended?: { enabled: boolean; minIntervalMs: number } };
  onFramesAppended?: (e: LiveFramesAppendedEvent) => void;
  onError?: (e: LiveAudioBufferError) => void;
}
```

Legacy `persistencePath` is removed. Equivalent today:

```ts
// before
createEmptyLiveAudioBuffer({ sampleRate, windowSeconds: 240, persistencePath: '/…/out.wav' });

// after
createEmptyLiveAudioBuffer({
  sampleRate,
  ringSeconds: 240,
  retention: { mode: 'path', path: '/…/out.wav' },
});
```

### 3.2 Producer options

```ts
export type AppendBackpressure = 'none' | 'block';

export function appendSamplesToLiveAudioBuffer(
  buffer: LiveAudioBufferRecordingSource,
  samples: Float32Array,
  sampleRate: number,
  options?: { backpressure?: AppendBackpressure; signal?: AbortSignal }
): Promise<void>;

export interface FileIngestOptions extends AudioDecodeOptions {
  autoFinalize?: boolean;
  /** Default: 'block'. Set 'none' if ring-only with explicit consumer catch-up. */
  backpressure?: AppendBackpressure;
}

export interface AppendOfflineOptions {
  /** Default: 'block'. */
  backpressure?: AppendBackpressure;
}
```

Internal defaults by source:

| Producer source | Default `backpressure` |
|---|---|
| `mic` | `'none'` (fixed; mic cannot block) |
| `file_ingest` | `'block'` |
| `append_offline` | `'block'` |
| `append` (JS) | `'none'` |

### 3.3 Cursor read errors — new error code

```ts
export const AudioBufferErrorCode = {
  // … existing codes
  CURSOR_LAG_EXCEEDED: 'AUDIO_CURSOR_LAG_EXCEEDED', // new
} as const;
```

`StreamingPipelineCompletion` already carries `reason: 'error'` + `errorCode`; no change needed on the pipeline-side surface.

### 3.4 Observability (kept, renamed for honesty)

| Before | After | Meaning |
|---|---|---|
| `totalSamplesDropped` | `ringEvictedSamples` | Count of ring cache evictions. **Not** equal to data loss anymore. |
| — (new) | `totalSamplesWritten` | Unchanged. |
| — (new) | `spoolRetainedSamples` | How many samples are currently held in spool (retention). |
| — (new) | `minCursorLagSamples` | Max lag of any cursor vs producer head. |

`ringEvictedSamples > 0` is now informational, not a loss indicator.

---

## 4. Native model

### 4.1 Entries share a single "store"

Both `LiveEntry` (Android, Kotlin) and `PaLiveEntry` (iOS, C++) get restructured:

```
LiveEntry
├─ ring: in-memory FloatArray of ringCapacity
├─ spool: file-backed (F32 WAV per spool-format-migration-spec.md)
├─ cursors: list of CursorHandle (each with absoluteReadPos)
├─ retentionPolicy: enum
├─ producerGate: condition variable (for 'block' backpressure)
└─ consumerGate: condition variable (for read waiters at EOF-recording)
```

Invariants:

1. After `appendSamples(N)`: ring contains last `min(totalWritten, ringCapacity)` samples; spool contains `[retentionStart, totalWritten)` (where `retentionStart` is 0 for `'session'`, `max(0, totalWritten - maxSpoolSamples)` otherwise).
2. Every cursor satisfies `retentionStart ≤ absoluteReadPos ≤ totalWritten`.
3. Producer with `backpressure: 'block'` additionally satisfies: `totalWritten - min(cursor.absoluteReadPos) ≤ retentionCapacity` — before the append returns.

### 4.2 Append path (pseudocode)

```
appendSamples(samples, source, backpressure):
  if backpressure == 'block':
    producerGate.wait_until( slowestCursor.absoluteReadPos + retentionCapacity >= totalWritten + samples.size )

  acquire ring write lock:
    write samples into ring (overwriting oldest as today — but this is cache eviction, not loss)
    totalWritten += samples.size

  spool.append(samples)                # outside ring lock

  trim spool according to retention:
    if retention == maxSeconds:
      drop spool bytes older than totalWritten - retentionCapacity
      (iff no cursor still points into that region)

  consumerGate.notify_all()
  dispatch onFramesAppended event
```

Append is **infallible** for `backpressure: 'none'`. For `'block'` it only waits; it never drops.

### 4.3 Cursor read path (pseudocode)

```
drainCursor(cursorId, maxSamples):
  c = cursors[cursorId]
  if c.absoluteReadPos < retentionStart:
    return Error(CURSOR_LAG_EXCEEDED)
  if c.absoluteReadPos >= totalWritten:
    return empty

  available = min(maxSamples, totalWritten - c.absoluteReadPos)
  if c.absoluteReadPos >= totalWritten - ringCapacity:
    # fast path — read from ring
    read `available` samples from ring at offset (c.absoluteReadPos mod ringCapacity)
  else:
    # slow path — read from spool
    read `available` samples from spool file at byte offset (c.absoluteReadPos * 4 + headerSize)

  c.absoluteReadPos += available
  producerGate.notify_one()   # in case a blocked producer can now proceed
  return samples[:available]
```

Spool read performance:
- With the F32 WAV-only spool format (per migration spec), spool bytes are directly readable as `float32` with a fixed 44-byte WAV header offset. No parsing per read, no per-sample conversion.
- On Android: `RandomAccessFile.seek(offset) + readFully(bytes)` — O(samples).
- On iOS: `std::fstream::seekg + read` — same. Optionally mmap.
- A 16 kHz mono f32 stream is 64 kB/s; even modest disks deliver >100 MB/s. Sequential spool reads are effectively free compared to inference time.

### 4.4 Retention trimming

For `maxSeconds` retention, the spool is logically a sliding window. Physical trim strategies:

- **Simple:** rewrite-in-place with a periodic truncate-from-head + seek-adjust. File system support for "truncate from head" is rare — instead use a **chunked-file spool** (segment files of e.g. 10 s each; delete oldest chunk when out of retention).
- **Alternative (smaller impact):** keep a single file but track a logical `retentionStart` offset; old bytes are "dead" but not deleted. Periodic compaction at a safe point (no cursor present in that region). Good enough for the SDK's temp-file lifecycle.

Both are compatible with the F32 WAV spool format. Chunked spool is recommended for long-running sessions (mic for hours); single-file with soft retention offset is simpler and sufficient for the current use cases.

### 4.5 Thread safety

- `ring` writes under a short exclusive mutex (same as today).
- `spool` writes are append-only and mutex-protected independently of the ring mutex.
- Cursor read path uses a reader mutex on the ring or the spool file descriptor.
- `producerGate` / `consumerGate` are condition variables with standard notify patterns.
- `finalize_()` flips buffer state to FINISHED, flushes pending events, notifies both gates (so blocked producers unwind and consumers wake to detect EOF).

---

## 5. Feature integration

No feature API changes. Every current consumer (`EnhancementPipelineWorker`, `StreamingSttWorker`, and equivalents) already uses `drainCursor` + `appendListener` — they automatically become lossless once the native read path dispatches to spool.

Concrete checklist per feature:

- **Enhancement streaming** — no code change in the worker; behavior becomes lossless automatically. Verify `unitsRead` at completion equals `totalSamplesWritten` minus the model's tail.
- **Streaming STT** — same. Add a test that consumes a file via `ingestFileToLiveAudioBuffer` and asserts that the transcript segments count is stable across runs (no missed audio).
- **Future features that add workers** — must keep using `createCursorHandle` + `drainCursor`. Workers **must** propagate `CURSOR_LAG_EXCEEDED` as an error rather than silently ignoring empty drains (already the case in the current workers since the error is thrown from the native call).

---

## 6. Breaking changes summary

| Area | Before | After |
|---|---|---|
| `CreateEmptyLiveAudioBufferOptions.persistencePath` | string | replaced by `retention` union |
| `CreateEmptyLiveAudioBufferOptions.windowSeconds` | rolling window seconds | renamed to `ringSeconds` (semantic: RAM cache only) |
| `PipelineAudioBufferInfo.totalSamplesDropped` | counted as data loss | renamed to `ringEvictedSamples`; no longer implies data loss |
| Producer drop semantics | lossy everywhere | lossless by default; opt-in `'none'` is now **documented** to be lossy-if-retention-none |
| New error code | — | `AUDIO_CURSOR_LAG_EXCEEDED` |
| `appendSamplesToLiveAudioBuffer` | sync/void | **async**, `Promise<void>` (supports backpressure wait) |

Migration notes for the example app and any user code:

```diff
- const live = await createEmptyLiveAudioBuffer({
-   sampleRate, windowSeconds: 240, persistencePath: outPath,
- });
+ const live = await createEmptyLiveAudioBuffer({
+   sampleRate,
+   ringSeconds: 240,
+   retention: { mode: 'path', path: outPath, trim: 'session' },
+ });

- appendSamplesToLiveAudioBuffer(live, samples, sr);
+ await appendSamplesToLiveAudioBuffer(live, samples, sr);
```

---

## 7. Phased implementation plan

Each phase compiles, passes tests, and is shippable on its own. Breaking changes are concentrated in phase 4.

### Phase 1 — Native spool-read path for cursors

Goal: `drainCursor` / `peekCursor` transparently read from the spool when the cursor is behind the ring, **without** changing producer semantics. Ring still evicts; consumer still snaps forward if spool is absent.

**Files:**
- `android/.../audio/pipeline/LiveEntry.kt`
  - Add `SpoolReader` (RandomAccessFile on the same path as `SpoolWriter`).
  - Extend `readFromCursor` to dispatch ring vs spool based on `oldestInRing`.
  - Guard: only dispatch to spool when the writer has flushed the required bytes. Track `spoolCommittedSamples` in `SpoolWriter` (incremented after `raf.write`).
- `ios/audio/pipeline/PaLiveEntry.h`
  - Mirror on C++ side (`std::fstream` or `mmap`).

**Tests:**
- Unit: write 2× ringCapacity worth of samples with spool enabled. Read via cursor from absolute 0 to end — expect exactly the written sequence.
- Unit: same without spool — expect truncated sequence + `ringEvictedSamples > 0` (pre-Phase 2 behavior kept for compatibility).
- Integration: reproduce the 30 min file Enhancement test; assert output duration ≈ input duration.

After Phase 1, the enhancement speedup bug is already fixed for any buffer with an active spool (which now includes all file-ingest-targeted buffers per the existing mandatory spool plan).

### Phase 2 — Typed `CURSOR_LAG_EXCEEDED` error

Goal: when the consumer is truly beyond retention (ring without spool, or spool trimmed too aggressively), surface a typed error instead of returning empty/stale data.

**Files:**
- Native `drainCursor` returns an error signal (sentinel value, or an out-parameter for Kotlin; for C++, a `std::optional` or exception-based result).
- `EnhancementPipelineWorker` and `StreamingSttWorker` propagate into their `error` field → existing completion callback reports `reason: 'error'`, `errorCode: 'AUDIO_CURSOR_LAG_EXCEEDED'`.
- TS types add the error code.

**Tests:**
- Unit: ring-only buffer, producer fast, consumer stalled → first drain past ring returns `CURSOR_LAG_EXCEEDED`.
- Integration: same via pipeline `completed` promise.

### Phase 3 — Producer backpressure (`block` mode)

Goal: deterministic producers (file ingest, offline append) can opt into `backpressure: 'block'` so the spool stays bounded to consumer pace.

**Files:**
- Native `appendSamples(...)` gains a `backpressure` parameter + `producerGate` condition variable.
- `startFileIngestToLiveBuffer`: pass `backpressure = block` by default; the decoder thread is already async, blocking it is safe.
- `appendOfflineToLiveAudioBuffer`: same.
- `appendSamplesToLiveAudioBuffer`: becomes `Promise<void>`; default `'none'`; `'block'` accepts an optional `AbortSignal` to unblock a producer whose consumer is about to be torn down.

**Tests:**
- Integration: 30 min file ingest, single consumer at 1× realtime, `ringSeconds: 10` → spool never exceeds `ringSeconds + epsilon` seconds on disk; decoder wall-time ≈ audio duration.
- Integration: file ingest cancelled mid-stream while blocked on backpressure → decoder unblocks, `ingest.done` rejects with `DECODE_CANCELLED`.

### Phase 4 — API surface & retention policy

Goal: ship the new `retention` union, remove `persistencePath` and `windowSeconds`, rename `totalSamplesDropped` → `ringEvictedSamples`, add `spoolRetainedSamples` / `minCursorLagSamples`.

**Files:**
- `src/audiobuffer/types.ts`, `src/audiobuffer/index.ts`
- `src/NativeSherpaOnnx.ts` and codegen
- Android `SherpaOnnxModule.kt` arg parsing + registry
- iOS bridge parsing + `PaLiveEntry`
- Example screens, docs under `docs/audiobuffer*.md`, `docs/enhancement-streaming.md`, `docs/migration/online/online-*.md`

**Tests:**
- Every `retention` mode has at least one integration test.
- Migration of `EnhancementStreamingScreen` and `PipelineShowcaseScreen` to the new options.

### Phase 5 — Chunked spool for long sessions (optional, follow-up)

Only required if a real use case surfaces for hours-long mic with aggressive retention trimming. Single-file + soft retention is sufficient until then.

---

## 8. Design decisions — why this shape and not the alternatives

- **Why not per-feature File APIs (old Option C)?** Breaks the "LiveAudioBuffer is the universal pipeline input" contract. Forces every feature (Enhancement, STT, future X) to grow a parallel file entry-point and re-solve the same problem.
- **Why not "producer policy = only for `file_ingest` string"?** Couples buffer correctness to producer naming. The decision of "can I block?" belongs to the caller, not to a magic string. Making it an explicit option keeps the contract clean for any future producer.
- **Why not "always backpressure the mic too"?** Physically impossible. Mic appends happen on the audio session thread; blocking there crashes audio. The opt-in is the honest API.
- **Why not "spool is optional, cursor errors if absent and behind"?** That's Phase 2 above, kept as an escape hatch (`retention: 'none'`) for users who explicitly want no disk I/O. It's not the default because it puts correctness on the SDK user.
- **Why F32 WAV as spool format?** See `docs/migration/mmap/spool-format-migration-spec.md` — already decided, in flight. Fixed 44-byte header + `float32` payload makes spool read trivial (offset = 44 + absolutePos × 4).

---

## 9. Acceptance criteria

A release of the SDK is considered done for this spec when:

1. The 30 min Enhancement test produces an output whose duration equals the input's duration (± model tail).
2. The same test, with `retention: 'auto'` and `ringSeconds: 10`, uses no more than 10 s worth of RAM for the input ring and spool disk peak stays within ~10 s + decoder-to-consumer slack.
3. Streaming STT over a file ingest produces stable transcripts across 5 runs (no missed segments).
4. Mic + stalled consumer with `retention: { mode: 'maxSeconds', seconds: 30 }` → consumer pipeline completes with `reason: 'error'`, `errorCode: 'AUDIO_CURSOR_LAG_EXCEEDED'` within ~30 s of stall.
5. Mic + healthy consumer → `ringEvictedSamples > 0` is normal, pipeline completes with `reason: 'completed'`.
6. Cancelling a blocked file ingest releases its thread within <50 ms and rejects `ingest.done` with `DECODE_CANCELLED`.
7. All existing docs and example screens reference the new API.

---

## 10. Out of scope (intentionally)

- **Multi-writer semantics** beyond current (multiple producers appending into one buffer already works and is preserved).
- **Cross-buffer pipelines** (e.g. enhancement-out → STT-in). Orthogonal; already works because the output live buffer of one feature is a normal LiveAudioBuffer for the next.
- **JSI zero-copy reads on the slow path.** Spool reads go through the bridge; given the typical data rate (tens of kB/s), this is not a bottleneck.
- **Native lock-free ring.** Current rwLock pattern is fine; optimizing contention is a separate perf topic.
