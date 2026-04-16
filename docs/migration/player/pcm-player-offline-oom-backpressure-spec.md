# PCM Player offline OOM prevention spec

## Status (April 2026)

Draft (implementation target).

## Purpose

Prevent offline playback from exhausting app heap when large buffers are played (including `mmap`-backed sources).

Primary failure pattern observed:

- offline producer drains quickly from source
- each chunk is copied and enqueued
- queue is effectively unbounded
- consumer (`AudioTrack` / output backend) cannot keep up
- heap grows until global OOM

This document defines a concrete, cross-platform target behavior for Android and iOS.

---

## Root cause summary

`mmap` solves storage backing, but playback still OOMs if in-process queue growth is unbounded.

Current risk points:

1. Unbounded queue growth (no backpressure).
2. Per-chunk extra allocations/copies.
3. No deterministic high-water stop condition in offline drain.
4. OOM can surface on unrelated threads once process heap is exhausted.

---

## Design goals

1. **Bounded memory footprint** during offline playback, independent of file length.
2. **No unbounded producer growth** (strict backpressure).
3. **Deterministic failure path** with `OFFLINE_OOM` when safety margins are violated.
4. **No behavior regression** for normal files and short clips.
5. **Same semantics** for pause/resume/seek/restart/onEnded.

---

## Target state

### 1) Queue budget becomes time-based and bounded

Replace unbounded/off-by-default queueing with a strict upper bound derived from audio duration budget:

- `maxBufferedMs` (default: `300ms`, configurable internally)
- `maxBufferedFrames = sampleRate * maxBufferedMs / 1000`
- queue cannot exceed `maxBufferedFrames` worth of payload

Rationale:

- stable memory regardless of clip duration
- predictable latency and throughput behavior
- tuning by human-friendly unit (ms), not chunk count

### 2) Hard backpressure on producer

When queue reaches budget:

- producer blocks (or waits on condition variable) until consumer drains below low-water mark
- no further allocation/enqueue while full

This is mandatory for offline drain and any future prefetch paths.

### 3) Buffer reuse to reduce allocation churn

Avoid repeated `copyOf()` allocations per chunk:

- introduce reusable chunk buffers (pool/ring of float arrays)
- producer fills reusable slots
- consumer returns slot to pool after write

Minimum requirement:

- eliminate one redundant copy on the hot path
- do not allocate new chunk arrays when reusable slot is available

### 4) Deterministic OOM failover (`OFFLINE_OOM`)

If allocation still fails (or heap guard trips):

- stop drain immediately
- stop accepting new chunks
- clear pending queue safely
- transition player session to terminal error state
- surface `OFFLINE_OOM` with actionable message:
  - "Not enough memory for offline playback buffering. Please use a streaming playback path for large audio inputs."

Note: best effort still applies if process is already unrecoverably exhausted.

---

## Queue policy details

### Watermarks

- **High-water mark**: queue >= `maxBufferedFrames` -> producer must wait.
- **Low-water mark**: producer resumes only after queue <= `resumeBufferedFrames`.
- default `resumeBufferedFrames = 50% of maxBufferedFrames`.

This hysteresis avoids wake/sleep thrash.

### Chunk size

Use fixed chunk size (existing baseline: `4096`) unless platform backend requires otherwise.

Chunk tuning rule:

- keep chunk size constant
- tune only `maxBufferedMs` and watermark ratios first
- revisit chunk size only if profiling shows clear gains

---

## Platform implementation notes

## Android

Target files:

- `android/src/main/java/com/sherpaonnx/pcm/PcmPlayerSession.kt`
- `android/src/main/java/com/sherpaonnx/pcm/PcmPlayerService.kt`

Required changes:

1. Replace unbounded `LinkedBlockingQueue` behavior with bounded frame-budget policy.
2. Add producer wait/notify (condition or bounded queue with explicit frame accounting).
3. Remove unnecessary `copyOf()` on enqueue path via reusable chunk strategy.
4. Emit `OFFLINE_OOM` at service boundary where promise can reject.
5. Keep `seek/restart` generation cancellation semantics intact.

## iOS

Target files:

- `ios/pcm/SherpaOnnx+PcmPlayer.mm`
- `ios/pcm/PcmPlayerRegistry.*` (if queue/session internals live there)

Required changes:

1. Apply same bounded budget semantics (`maxBufferedMs`).
2. Ensure offline enqueue helper cannot outrun consumer without waiting.
3. Use reusable chunk buffers (or equivalent reuse strategy).
4. Map memory failure path to `OFFLINE_OOM`.
5. Preserve event and control API semantics.

---

## API and behavior contract

No public API changes required.

Existing APIs keep current shape:

- `createPcmPlayer(...)`
- `pause()`, `resume()`, `seekToMs()`, `restart()`, `destroy()`
- `onEnded`

Error contract change:

- offline playback may reject/fail with `OFFLINE_OOM` instead of eventual process crash.

---

## Telemetry/logging requirements

Add low-noise diagnostics (debug level), gated to avoid spam:

- queue frames / buffered ms
- producer blocked duration
- watermark transitions
- dropped/failed allocation count
- final fail reason (`OFFLINE_OOM` path)

All new OOM diagnostics should remain filterable with existing `OOM` token.

---

## Acceptance criteria

1. Playing very large offline buffers no longer shows monotonic queue growth to heap limit.
2. Peak queue memory remains within configured budget envelope.
3. On memory pressure, player fails fast with `OFFLINE_OOM` (where recoverable), not delayed global crash.
4. Seek/restart/pause/resume behavior remains functionally correct.
5. No regressions in normal playback latency or completion event behavior.

---

## Suggested rollout order

1. Android bounded queue + backpressure.
2. Android chunk reuse optimization.
3. iOS bounded queue + backpressure.
4. iOS chunk reuse optimization.
5. Final cross-platform `OFFLINE_OOM` contract validation + docs check.

