# AudioBuffer migration plan: JSI / External ArrayBuffer only

## Purpose

This document defines the high-level migration goal for AudioBuffer sample transport:

- remove `number[]` sample transport completely from the JS API surface
- move sample exchange to JSI / External ArrayBuffer only
- keep the existing pipeline-first architecture as the default recommendation for most users
- position direct sample access as an advanced/power-user path

This is a strategy document only (no concrete TypeScript signatures or implementation details).

---

## Current state (as-is)

Today, sample transport between JS and native still relies on `number[]` in key paths:

- offline input from JS: `createOfflineAudioBufferFromSamples(samples: number[], ...)`
- live input from JS: `appendSamplesToLiveAudioBuffer(..., samples: number[], ...)`
- live output to JS: `getLiveAudioBufferSamplesSlice(...): Promise<number[]>`
- optional live append events may include `samples?: number[]`

Implications:

- high bridge overhead for large sample counts
- extra allocations and GC pressure in JS
- increased OOM risk for large or frequent transfers
- inconsistent performance for power-user workloads

---

## Target state (to-be)

Audio sample transport on the JS side uses JSI / External ArrayBuffer as the only supported data path.

Expected outcome:

- no public `number[]` sample APIs remain
- large sample transfer becomes low-copy / zero-copy oriented
- predictable performance for high-throughput use cases
- better memory behavior under sustained streaming and large offline buffers

Scope:

- offline and streaming AudioBuffer sample I/O paths
- sample reads (native -> JS) and writes (JS -> native)
- related docs and migration guides

---

## Principles

1. **Performance first for sample transport**
   - design around throughput, allocation control, and minimal copying.

2. **Pipeline-first remains primary**
   - default app flows should continue to prefer native pipeline composition (buffer-to-buffer processing without JS sample loops).

3. **Power-user path is explicit**
   - direct sample access is supported for advanced scenarios, but documented as an expert feature.

4. **Consistent API direction**
   - offline and live buffers should follow the same transport model and developer expectations.

5. **Breaking changes are allowed**
   - `number[]`-based sample interfaces can be removed instead of deprecated.

---

## Documentation strategy

At each relevant AudioBuffer API reference entry, add a short **Notice** section that clarifies:

- pipeline-first APIs are preferred for most workloads
- direct sample transport is an advanced/power-user feature
- JSI / External ArrayBuffer is used for performance-sensitive transfer
- large sample movement over legacy bridge arrays is intentionally not supported

Suggested placement:

- `docs/audiobuffer-offline.md` API reference sections touching sample input/output
- `docs/audiobuffer-streaming.md` API reference sections touching sample input/output
- cross-link from `docs/audio-conversion.md` where users may otherwise expect raw JS sample roundtrips

---

## Migration phases (high level)

### Phase 1: alignment and inventory

- identify all remaining `number[]` sample entry points across JS and native bridges
- classify by direction: JS -> native, native -> JS, event payloads
- define removal boundaries and compatibility expectations

### Phase 2: JSI transport rollout

- introduce JSI / External ArrayBuffer transport path across offline + live sample flows
- ensure read/write paths both use the same transport philosophy
- keep behavior semantically equivalent where possible

### Phase 3: remove legacy array transport

- remove `number[]` sample APIs from public JS surface
- remove bridge/event payload contracts that expose sample arrays
- update internal tests and docs to the new baseline

### Phase 4: documentation and migration communication

- update API references, migration docs, and examples
- clearly communicate breaking changes and new best practices
- provide guidance for power users moving from arrays to JSI buffers

---

## Non-goals

- defining exact TypeScript signatures in this document
- prescribing low-level native implementation details
- changing pipeline behavior for STT/TTS/enhancement beyond sample transport concerns

---

## Success criteria

- no `number[]` sample transport remains in public AudioBuffer APIs
- both offline and live sample paths use JSI / External ArrayBuffer
- docs consistently mark direct sample access as advanced and pipeline-first as default
- migration guidance is clear enough for existing power users to adapt without ambiguity

