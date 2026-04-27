# Segmentation Engine Spec

## Status

- **Draft v2** (expanded from v1)
- Scope: high-level architecture, contracts, pipeline modes, and sub-plan index
- Audience: SDK maintainers and feature owners (STT, TTS, Punctuation, Alignment, VAD, Enhancement)

## Purpose

Define a shared segmentation architecture that:
- Eliminates per-feature custom chunking logic.
- Keeps runtime behavior consistent across live and offline flows.
- Enables segment-wise processing for large offline inputs to prevent OOM.
- Provides a single, unified segmentation contract that all features consume.

> **Core authority rule:** The Segmentation Engine *decides* boundaries. Buffers are *stateful sinks/sources* for segment data. JS receives hints, not decision authority.

## Goals

- Centralize segmentation rules and state transitions in a single native engine.
- Reuse one segmentation contract across text and audio domains.
- Keep JS bridge traffic low (event hints + pull APIs, no JS-side decision loops).
- Enable segment-wise processing for large offline inputs to reduce peak memory.
- Ship a clean, public-SDK-ready architecture on first release.
- **Eliminate the need for TTS incremental engine** — replace with Segmentation Engine + Offline TTS orchestration.
- **Symmetric Public Write API** — both domains expose the same 2-level write model (data level + segment level).

## Non-Goals

- Not a full implementation doc for one specific feature (sub-plans handle that).
- Not a replacement for model-specific decoding logic.
- Not a UI-level event semantics document.
- No backward-compatibility layer for legacy segmentation behavior.

## Release Policy

- **Cold/clean cut** — no compatibility shims, dual-path runtime, or legacy fallback.
- Existing feature-specific segmentation paths are replaced before public SDK release.
- TTS incremental engine and its associated logic are removed once Segmentation Engine + Offline TTS parity is validated (see Gates below).

---

## Architecture Layers

### 1) Buffer Layer (Native)

- `LiveTextBuffer` and `LiveAudioBuffer` hold streaming state and cursorable data.
- Both buffer types follow the **Symmetric 2-Level Write Model** (see below).
- Buffers expose stream events:
  - `LiveTextBuffer`: `onPartial`, `onSegment`, `onError`
  - `LiveAudioBuffer`: `onFramesAppended`, `onSegment`, `onError`
- Buffers keep internal segment artifacts via embedded or associated `SegmentBuffer`.
- Buffers support both **manual** and **automatic** segment commit.

### 2) Segmentation Engine (Native Core)

- Evaluates segmentation policies and emits segment boundaries.
- Runs in native runtime; no JS dependency for boundary decisions.
- Supports domain-specific policies (see Domain Model below).
- Engine **decides**, buffer **stores**. No dual-authority.

### 3) Feature Pipelines (Native)

- STT/TTS/Punctuation/Alignment/VAD/Enhancement consume segmentation output.
- Features may opt in/out per use case, but the contract remains shared.
- Per-feature execution semantics are allowed (e.g., Enhancement uses `continuous_frames`).

### 4) JS API Surface

- Optional `onSegment` notifications (hint channel).
- Pull/read APIs for deterministic data access.
- Configuration APIs for policy selection and thresholds.

---

## Symmetric Public Write API

### Problem: Current Asymmetry

Today the public write API is asymmetric across domains:

| Capability | Text | Audio |
|---|---|---|
| **Data-level write** (append raw data) | ❌ Partial is read-only / event-only from JS | ✅ `appendSamples()` |
| **Segment-level commit** (commit a segment) | ✅ `appendLiveTextSegment()` | ❌ Not established as symmetric public API |

This forces SDK users to learn domain-specific write patterns and prevents the Segmentation Engine from attaching uniformly.

### Target: Symmetric 2-Level Write Model

Every LiveBuffer exposes **two write levels** with the same mental model:

```
┌─────────────────────────────────────────────────────────────┐
│                  Symmetric Write Model                       │
│                                                              │
│   Level 1 — Data                                             │
│     Text:   setPartial(text) / appendPartial(text)           │
│     Audio:  appendFrames(samples)                            │
│                                                              │
│   Level 2 — Segment                                          │
│     Text:   commitSegment()  (manual or auto via engine)     │
│     Audio:  commitSegment()  (manual or auto via engine)     │
│                                                              │
│   Events                                                     │
│     Text:   onPartial, onSegment, onError                    │
│     Audio:  onFramesAppended, onSegment, onError             │
│                                                              │
│   Segmentation Modes (both domains identical)                │
│     'off'    → data level only, no segments                  │
│     'manual' → user calls commitSegment() explicitly         │
│     'auto'   → engine observes data level, commits segments  │
└─────────────────────────────────────────────────────────────┘
```

### Concrete API Symmetry

| Operation | Text (LiveTextBuffer) | Audio (LiveAudioBuffer) |
|---|---|---|
| **Append data** | `setPartial(text)` / `appendPartial(text)` | `appendFrames(samples)` |
| **Read data** | `getPartialSlice(start, max)` | `getSamplesSlice(start, count)` |
| **Manual commit** | `commitSegment(buffer)` | `commitSegment(buffer)` |
| **Read segments** | `getSegments(buffer, start, max)` | `getSegments(buffer, start, max)` |
| **Segment count** | `getSegmentCount(buffer)` | `getSegmentCount(buffer)` |
| **Data event** | `onPartial` | `onFramesAppended` |
| **Segment event** | `onSegment` | `onSegment` |
| **Error event** | `onError` | `onError` |

`commitSegment()` is the **same function** for both domains. It accepts a `LiveTextBufferRef | LiveAudioBufferRef` and produces the domain-appropriate segment type.

### New Public Write APIs for Text

The existing `LiveTextBuffer` only exposes partial text as read/event. To achieve symmetry, the following **new public write APIs** are introduced:

```typescript
/**
 * Replace the current partial text.
 * This is the text-domain equivalent of appendFrames() — raw data input.
 */
function setPartial(
  buffer: LiveTextBufferRef,
  text: string
): void;

/**
 * Append to the current partial text.
 */
function appendPartial(
  buffer: LiveTextBufferRef,
  text: string
): void;
```

These make `LiveTextBuffer` a symmetric data sink: producers (STT, user input, API) all write via the same public data-level API.

> **Note:** Today, native pipeline workers (STT) write partials directly via native-internal APIs. The new `setPartial`/`appendPartial` are **public SDK APIs** that give JS callers (and external producers) the same capability. Native-internal write paths remain and are unaffected.

### New Public Write APIs for Audio Segment Commit

The existing `LiveAudioBuffer` has `appendSamples()` (data level) but no symmetric segment commit. The following is introduced:

```typescript
/**
 * Manually commit the current accumulated frames as a segment.
 * Same function as for text — overloaded by buffer type.
 */
function commitSegment(
  buffer: LiveAudioBufferRef,
  options?: { reason?: SegmentReason }
): SpeechSegment;
```

### Why This Matters for Segmentation Engine

The Segmentation Engine attaches to any LiveBuffer and operates on the same model:

1. **Observe data-level writes** (partial updates / frame appends)
2. **Evaluate policy** (text rules / audio rules)
3. **Call `commitSegment()`** when a boundary is detected

Because both domains now have the same 2-level structure, the engine attachment logic, policy evaluation loop, and commit path are **structurally identical** — only the policy evaluator implementation differs per domain.

### Design Rule

> Every new buffer write capability must maintain 2-level symmetry. If a new write operation is added to one domain, the analogous operation must exist (or be explicitly documented as N/A) in the other domain.

---

## Domain Model

### Text Segmentation

- **Input sources:** partial text updates + committed text updates.
- **Boundary signals:** endpointing, punctuation-assisted rules, length rules, language-aware heuristics.
- **Output artifact:** text segment records in `SegmentBuffer`.
- **Modes:**
  - `synthetic_auto` — deterministic rules only (no model required)
  - `punctuation_model_assisted` — uses punctuation model output as signal, then applies `synthetic_auto` rules as post-processing

### Speech Segmentation

- **Input sources:** live audio frames and optional model outputs (e.g., VAD).
- **Boundary signals:** silence/energy or VAD-based transitions.
- **Output artifact:** speech segment records in `SegmentBuffer`.
- **Modes:**
  - `energy_silence` — deterministic heuristics only (no model required)
  - `vad_model` — uses sherpa-onnx VAD model
- **Special policy:**
  - `continuous_frames` — for features like Enhancement that operate on continuous frame drain (see Enhancement section)

---

## Segment Contract

> **Two core artifacts:**
> - **Segment** = boundary within a single domain (`text` or `speech`)
> - **SegmentLink** = relationship *between* domains (text ↔ speech) — see below

### Common Fields

| Field | Type | Description |
|---|---|---|
| `segmentId` | `string` | Unique identifier (UUID) |
| `domain` | `'text' \| 'speech'` | Domain discriminator |
| `startOffset` | `number` | Start position (UTF-16 index for text, sample index for speech) |
| `endOffset` | `number` | End position |
| `reason` | `SegmentReason` | Why the segment was created |
| `source` | `SegmentSource` | What created the segment |
| `createdAtMs` | `number` | Timestamp of segment creation |

### SegmentReason Enum

```typescript
type SegmentReason =
  | 'endpoint'          // STT endpoint / silence detection
  | 'punctuation'       // punctuation-based boundary
  | 'length_limit'      // max-length policy triggered
  | 'vad_boundary'      // VAD speech boundary
  | 'energy_silence'    // energy/silence threshold
  | 'manual_commit'     // user/API explicit commit
  | 'finalize'          // buffer finalization
  | 'policy_checkpoint' // coarse checkpoint from continuous policy
```

### SegmentSource Enum

```typescript
type SegmentSource =
  | 'segmentation_engine'  // engine auto-segmented
  | 'manual'               // API/user manual commit
  | 'external'             // future: external segment buffer
```

### Domain-Specific Extensions

#### Text Segment Extension

| Field | Type | Optional | Description |
|---|---|---|---|
| `text` | `string` | ❌ | The segment text content |
| `tokens` | `string[]` | ✅ | Token-level breakdown |
| `timestamps` | `number[]` | ✅ | Per-token timing |
| `lang` | `string` | ✅ | Detected language |

#### Speech Segment Extension

| Field | Type | Optional | Description |
|---|---|---|---|
| `sourceAudioBufferId` | `string` | ❌ | Reference to audio buffer |
| `sampleRate` | `number` | ❌ | Sample rate of referenced audio |
| `durationMs` | `number` | ❌ | Computed duration |
| `confidence` | `number` | ✅ | Model confidence score |
| `energy` | `number` | ✅ | Average energy level |
| `vadInfo` | `object` | ✅ | VAD-specific metadata |

---

## Pipeline Modes

### Offline Pipelines

#### Mode 1: Full Run (No Segmentation)

```
OfflineBuffer₁ → OfflineConsumer → OfflineBuffer₂
```

- Consumer processes the entire buffer content in a single invocation.
- Full content must fit in memory at processing time.
- Suitable for small inputs or when memory is not a concern.
- `segmentation.mode = 'off'`

#### Mode 2: Full Run with Internal Segmentation

```
OfflineBuffer₁ + SegmentationEngine → OfflineConsumer (per segment) → OfflineBuffer₂
```

- SegmentationEngine partitions the input buffer into segments internally.
- Consumer is invoked once per segment. Results are collected and merged into the output buffer.
- **Text:** intermediate results stored in-memory (text is small).
- **Audio:** intermediate results collected via internal `LiveAudioBuffer` → `transferOfflineAudioBufferFromLive` (see Sub-Plan 04).
- `segmentation.mode = 'auto'` with a policy configuration.

### Streaming/Online Pipelines

#### Mode 3: Manual Segment Commit

```
LiveBuffer₁ → StreamingConsumer → LiveBuffer₂
```

- Data is appended to `LiveBuffer₁`.
- Segments are committed explicitly via API call (`commitSegment()`).
- On commit, the segment is forwarded to the consumer for processing.
- `segmentation.mode = 'manual'`

#### Mode 4: Automatic Segment Commit

```
LiveBuffer₁ + SegmentationEngine → StreamingConsumer → LiveBuffer₂
```

- Data is appended to `LiveBuffer₁`.
- SegmentationEngine monitors the buffer and auto-commits segments based on policy.
- On auto-commit, the segment is forwarded to the consumer for processing.
- `segmentation.mode = 'auto'` with a policy configuration.

#### Mode 5: Continuous Frames (Enhancement Special Case)

```
LiveAudioBuffer₁ → StreamingEnhancement (continuous drain) → LiveAudioBuffer₂
```

- Input is consumed continuously via frame-drain, not via segment-commit.
- No per-frame segment objects are materialized.
- Optional coarse checkpoints emitted for orchestration/observability.
- `segmentation.mode = 'auto'`, `policy.type = 'continuous_frames'`

---

## Segmentation Configuration Type

```typescript
interface SegmentationConfig {
  /** Segmentation mode */
  mode: 'off' | 'auto' | 'manual';

  /** Policy configuration (required when mode = 'auto') */
  policy?: SegmentationPolicy;

  /**
   * Future: external segment buffer that overrides engine segmentation.
   * When provided, the engine is skipped and these segments are used directly.
   * NOT implemented in v1 — structure is reserved.
   */
  externalSegmentBuffer?: OfflineSegmentBufferRef;
}

/** Union of all policy types */
type SegmentationPolicy =
  | TextSyntheticAutoPolicy
  | TextPunctuationAssistedPolicy
  | SpeechEnergySilencePolicy
  | SpeechVadModelPolicy
  | ContinuousFramesPolicy;

interface TextSyntheticAutoPolicy {
  type: 'synthetic_auto';
  maxLengthChars?: number;        // max segment length
  sentenceBoundary?: boolean;      // prefer sentence boundaries
  languageHints?: string[];        // language-aware heuristics
}

interface TextPunctuationAssistedPolicy {
  type: 'punctuation_model_assisted';
  maxLengthChars?: number;
  sentenceBoundary?: boolean;
  languageHints?: string[];
  // punctuation model reference is provided via the feature config, not here
}

interface SpeechEnergySilencePolicy {
  type: 'energy_silence';
  silenceThresholdMs?: number;     // min silence duration to trigger boundary
  energyThresholdDb?: number;      // energy threshold
  minSegmentMs?: number;           // minimum segment duration
  maxSegmentMs?: number;           // maximum segment duration
  hangoverMs?: number;             // hangover time after silence detection
}

interface SpeechVadModelPolicy {
  type: 'vad_model';
  minSegmentMs?: number;
  maxSegmentMs?: number;
  // VAD model reference is provided via the feature config, not here
}

interface ContinuousFramesPolicy {
  type: 'continuous_frames';
  checkpointIntervalMs?: number;   // optional coarse checkpoint interval
  // Enhancement-specific: no segment materialization per frame
}
```

---

## Enhancement and Segmentation: Unified Contract with Continuous Execution

### Decision

Streaming Enhancement adopts the shared Segmentation Engine contract, but keeps a continuous frame-drain execution model internally.

### Architecture Rule

- Segmentation contracts are unified across features.
- Execution strategies may differ by feature.
- For Enhancement, segmentation policy controls orchestration and observability, not per-frame segment materialization.

### Enhancement Default Policy: `continuous_frames`

| Aspect | Behavior |
|---|---|
| Input consumption | Continuous from `LiveAudioBuffer` via frame-drain |
| Model inference | Continuous on frame-sized chunks |
| Output | Appended continuously to output buffer |
| Segment objects | Not materialized per frame |
| Coarse checkpoints | Optional, at configurable intervals |

### Bridge and Event Policy

- JS must not be in the critical decision loop for frame-level segmentation.
- Optional events are hints for UI/observability.
- Primary data access remains pull-based via buffer APIs.
- Event payloads for audio remain metadata-only (no PCM payload blocks).

---

## Segment Storage in Buffers

### Design Principle

> **"Unified external segment access, implementation-defined internal storage."**

For the SDK user, segment access is always the same API regardless of domain. Internally, each domain may store segments differently for technical reasons — but this is hidden behind a unified accessor.

### Public API: `getSegmentBuffer()`

```typescript
/**
 * Get the segment buffer associated with any LiveBuffer.
 * Returns a SegmentBufferRef that provides a unified view of the buffer's segments.
 *
 * For LiveTextBuffer: returns a view/proxy over the embedded segment log.
 * For LiveAudioBuffer: returns the associated LiveSegmentBuffer.
 * For OfflineBuffers: returns the associated OfflineSegmentBuffer.
 *
 * The caller does not need to know which internal storage model is used.
 */
function getSegmentBuffer(
  buffer: LiveTextBufferRef | LiveAudioBufferRef | OfflineTextBufferRef | OfflineAudioBufferRef
): SegmentBufferRef;
```

All segment read operations work on both the parent buffer **and** the `SegmentBufferRef`:

```typescript
// Both of these are equivalent:
getSegments(textBuffer, 0, 10);            // via parent buffer
getSegments(getSegmentBuffer(textBuffer), 0, 10); // via segment buffer ref

// Same for audio:
getSegments(audioBuffer, 0, 10);
getSegments(getSegmentBuffer(audioBuffer), 0, 10);
```

### Internal Storage (implementation-defined)

| Domain | Internal Model | Rationale |
|---|---|---|
| **Text (Live)** | Embedded segment log in LiveTextBuffer | Natural extension of the partial → commit model. Segments are part of the text lifecycle. |
| **Audio (Live)** | Associated/separate LiveSegmentBuffer | Keeps PCM storage clean. Segments can reference multiple audio buffers. LiveSegmentBuffer already exists. |
| **Text (Offline)** | Associated OfflineSegmentBuffer | Computed once, stored separately. |
| **Audio (Offline)** | Associated OfflineSegmentBuffer | Computed once, stored separately. |

**`getSegmentBuffer()` hides this difference:**
- For LiveTextBuffer: returns a lightweight proxy that delegates to the embedded log.
- For LiveAudioBuffer: returns the actual associated LiveSegmentBuffer.
- For OfflineBuffers: returns the OfflineSegmentBuffer.

### Consistency Rule

All buffers expose the same segment query APIs via `getSegmentBuffer()`. A consumer reading segments from any buffer type sees the same `Segment` contract shape, uses the same `getSegments()` / `getSegmentCount()` functions, and does not need to know about internal storage differences.

---

## Segmentwise Equivalence Matrix

Not all features produce identical results when run segment-by-segment vs. full-buffer.

| Feature | Equivalence Class | Notes |
|---|---|---|
| STT (Offline) | **approximate** | Context loss at segment boundaries may affect accuracy |
| TTS (Offline) | **approximate** | Prosody/intonation differences at segment joints |
| Punctuation | **approximate** | Sentence context may differ at boundaries |
| Enhancement | **approximate** | Boundary artifacts possible without overlap |
| Alignment | **approximate** | Timing drift at segment joints |
| VAD | **exact** | VAD is inherently segment-producing |

### Mitigation Strategies (per feature, to be detailed in future specs)

- **Overlap windows:** Process with N ms overlap at boundaries, cross-fade results.
- **Context carry-forward:** Pass last N tokens/samples from previous segment as context.
- **Merge rules:** Post-processing to smooth boundary artifacts.
- **Quality flags:** Expose `segmentwise_quality: 'exact' | 'approximate'` in segment metadata.

---

## `transferOfflineAudioBufferFromLive` — Zero-Copy Transfer

### Purpose

Enable efficient conversion from a finalized `LiveAudioBuffer` (with spool) to an `OfflineAudioBuffer` without full data copy.

### Why It Matters

In Mode 2 (offline with segmentation), per-segment results are collected in a `LiveAudioBuffer`. Converting to `OfflineAudioBuffer` for the final output should avoid copying the entire audio stream.

### Design

```typescript
transferOfflineAudioBufferFromLive(
  liveBuffer: LiveAudioBufferRef,
  mode: 'fullIfSpooled'
): OfflineAudioBufferRef
```

### Invariants

| Invariant | Enforcement |
|---|---|
| Live buffer must be finalized | Error: `INVALID_STATE` |
| Spool must be available | Error: `SPOOL_UNAVAILABLE` |
| No open cursors/writers | Error: `CURSORS_ACTIVE` |
| Atomic ownership handoff | Spool file ownership transfers to Offline buffer |
| Live buffer invalidated after transfer | All subsequent operations on Live buffer return `BUFFER_INVALIDATED` |
| Crash-safe cleanup | Partial transfer cleans up on failure |

### File Format Consideration

Current `OfflineAudioBuffer` file format is raw `.f32` (no header). `LiveAudioBuffer` spool is Float32 WAV (44-byte header).

**Options:**
1. **Copy with header strip** (current `createOfflineAudioBufferFromLive` behavior) — safe but defeats zero-copy purpose.
2. **Support `dataOffsetBytes` in OfflineAudioBuffer reader** — allow the offline reader to skip N bytes (44 for WAV header), treating the rest as raw F32. This enables true file transfer without copy.

**Recommendation:** Option 2. Add `dataOffsetBytes` to the `FileBacked` variant of `OfflineEntry`. The mmap region starts at `dataOffsetBytes` instead of byte 0. This is a small, localized change that enables zero-copy transfer.

---

## TTS Incremental Engine Removal — Gates

The TTS incremental engine can be removed once these gates are passed:

| Gate | Criteria | Status |
|---|---|---|
| **Parity Gate** | Segmentation-orchestrated Offline TTS achieves ≥ equivalent UX (latency, stability, abort) | ⬜ Not started |
| **Contract Gate** | Segment Contract + Policy API are stable, no short-term breaking redesigns expected | ⬜ Not started |
| **Ops Gate** | Clear error/recovery semantics for flush/reset/finalize in long sessions | ⬜ Not started |

---

## Bridge Strategy

- Native owns segmentation decisions and segment persistence.
- JS observes via optional notifications and reads via explicit APIs.
- Avoid per-update roundtrips for boundary decisions.
- Event payloads:
  - **Audio `onSegment`:** metadata only (segment IDs, indices, offsets). No PCM blocks.
  - **Text `onSegment`:** metadata + optional short text content allowed (text is small).
  - Bridge budget and coalescing are explicit design criteria.

---

## Open Questions

### Event Payload Content (Priority: High — ✅ Resolved)
- **Text `onSegment`:** Full segment metadata **including `text` field**. Text payloads are small (< 1 KB). Including text avoids a follow-up read for common UI scenarios (live transcription display).
- **Audio `onSegment`:** Segment metadata **without PCM data**. Payload includes only IDs, offsets, duration, confidence. Consumer reads audio via buffer slice APIs.
- **Coalescing:** No coalescing. Each segment gets its own event. Segments are infrequent compared to partials/frames. Coalescing would lose segment boundaries.
- **Throttling:** Optional `segmentAppended.minIntervalMs` setting (default: 0 = immediate).
- **Rule:** `onSegment` is advisory/hint-only. Pull APIs (`getSegments`, `getSegmentCount`) are authoritative.

### Segment Storage Location (Priority: Medium — ✅ Resolved)
- **Solution:** Unified external access via `getSegmentBuffer(buffer)`, implementation-defined internal storage.
- Public API is identical for both domains: `getSegmentBuffer()`, `getSegments()`, `getSegmentCount()` accept any buffer type.
- Internally: text embeds segments (natural commit model), audio keeps a separate associated `LiveSegmentBuffer` (clean PCM/metadata separation).
- `getSegmentBuffer()` returns a proxy/view for text and the actual associated buffer for audio.
- **Principle:** *"Unified external segment access, implementation-defined internal storage."*
- Full design: **Sub-Plan 03 § Segment Storage**.

### Cross-Domain Linkage (Priority: Low — ✅ Resolved)
- **Solution:** `SegmentLink` + `SegmentLinkMap` — defined as **core types in Sub-Plan 01** (not Alignment-specific).
- `SegmentLink` is domain-agnostic and feature-agnostic. Any feature producing text↔speech relationships uses this one type.
- `SegmentLinkType` includes: `alignment`, `proportional`, `vad_assisted`, `sequential`, `tts_produced`, `stt_produced`, `user_defined`.
- `SegmentLinkMap`: bidirectional N:M mapping, native-held, in-memory.
- Types are implemented in **Phase 1** (alongside Segment types). First feature consumer is Alignment (Phase 6), but TTS/STT can use them earlier.
- Full type definitions: **Sub-Plan 01 § Cross-Domain Linkage**.
- Alignment-specific strategies (text-driven, speech-driven, joint): **Sub-Plan 05, Feature 5**.

### Intermediate Result Storage for Audio Segmented Processing (Priority: High — ✅ Resolved)
- **Decision:** Use internal `LiveAudioBuffer` accumulator + `transferOfflineAudioBufferFromLive('fullIfSpooled')` for final output handoff.
- **Lifecycle (resolved):**
  - Create `OrchestrationSession` per pipeline run.
  - Create accumulator `LiveAudioBuffer` with deterministic temp naming (`orch_{sessionId}_acc.wav`).
  - Process per segment, append outputs to accumulator.
  - Finalize accumulator, transfer to `OfflineAudioBuffer`, invalidate live accumulator.
  - Enforce deterministic cleanup in all terminal states (`done`, `failed`, `cancelled`, `partial`).
- **Error recovery (resolved):**
  - `errorRecovery` strategies: `abort` (default), `skip`, `retry`, `partial_result`.
  - Return structured `OrchestrationResult` with status, completed/skipped/failed segment metadata.
  - Support `AbortSignal` cancellation with strategy-specific output behavior.
  - Treat accumulator and transfer failures as fatal orchestration errors.
  - Run orphan temp-file sweep at startup for crash recovery.
- **Reference:** Full normative details are defined in **Sub-Plan 04** (`sub-04-transfer-offline-orchestration.md`) including state machine, lifecycle, cancellation, recovery strategies, and error taxonomy.

### Intermediate Result Storage for Text Segmented Processing (Priority: Low — ✅ Resolved)
- **Decision:** In-memory collection is sufficient for text segmented processing.
- **Not required:** active-window + spooling logic analogous to audio.
- **Scope note:** This decision applies to text intermediate result accumulation during segmented offline orchestration and segment processing paths.

### External SegmentBuffer (Priority: Low — deferred)
- Structure reserved in `SegmentationConfig`.
- Not implemented in v1.
- When implemented: hard validation checks (sorted, non-overlapping, in range, sampleRate/lang/kind match).

---

## Sub-Plans

| # | Sub-Plan | File | Scope |
|---|---|---|---|
| 01 | Segment Contract & Types | `sub-01-segment-contract.md` | Canonical segment data model + SegmentLink/SegmentLinkMap cross-domain types, TypeScript/Kotlin/C++ definitions |
| 02 | Segmentation Engine Core | `sub-02-segmentation-engine-core.md` | Engine interface, policy evaluation, buffer integration points |
| 03 | Buffer Integration & Events | `sub-03-buffer-integration.md` | onSegment events, segment storage in buffers, pull APIs, commit mechanics |
| 04 | Transfer & Offline Orchestration | `sub-04-transfer-offline-orchestration.md` | transferOfflineAudioBufferFromLive, offline segmented processing loop, intermediate result management |
| 05 | Feature Pipeline Migration | `sub-05-feature-pipeline-migration.md` | Per-feature migration plan (STT, TTS, Punctuation, Enhancement, Alignment, VAD) |

---

## References

- `docs/migration/segmentationEngine/segmentation-engine-foundation.md`
- `docs/migration/segmentationEngine/sdk-feature-support-matrix.md`
- `docs/internal/liveaudiobuffer-internal.md`
- `docs/internal/livetextbuffer-internal.md`
- `docs/internal/livesegmentbuffer-internal.md`
- `docs/internal/offlineaudiobuffer-internal.md`
- `docs/internal/offlinetextbuffer-internal.md`
- `docs/internal/offlinesegmentbuffer-internal.md`
