# Sub-Plan 05: Feature Pipeline Migration

## Status
- **Phase 2 (STT + VAD + `stt_produced`):** Completed — Implementierung und Parity-Check (Plan `phase-2-vad-stt`, Jest: `segment-api`, `transcribe-segmented`, `offline-orchestrator`) erfüllt.
- **Phase 3 (Enhancement offline segmentiert + Streaming `continuous_frames`):** Completed — Offline Enhancement nutzt optional den Phase-1c-Audio-Orchestrator, befüllt das Caller-`audioOut` via `populateOfflineAudioBufferIfEmpty`, Streaming Enhancement kann `continuous_frames` als Checkpoint-only Attach nutzen, und native Offline-Segmentation bleibt chunked.
- **Weitere Features in diesem Dokument (TTS, Punctuation, Alignment, …):** weiterhin offen / spätere Phasen.
- Depends on: Sub-Plan 01, 02, 03, 04

## Purpose

Define per-feature migration plans to adopt the shared Segmentation Engine. Each feature section covers: current state, target state, migration steps, and breaking changes.

---

## Migration Principles

1. **One feature at a time.** Features are migrated independently.
2. **Contract first.** Feature consumes the Segment Contract; it does not define its own segmentation.
3. **Remove old segmentation code** after migration is validated.
4. **Test parity** between old and new behavior before switching.

---

## Feature 1: STT (Speech-to-Text)

### Current State

- **Streaming STT:** Real streaming via sherpa-onnx `OnlineRecognizer`. Endpoint detection is model-internal. On endpoint → commits text segment to `LiveTextBuffer`. No explicit segmentation engine.
- **Offline STT:** Single-shot `OfflineRecognizer` on full `OfflineAudioBuffer`. No segmentation.

### Target State

- **Streaming STT:** Model-internal endpointing continues as-is (it's native streaming). The STT pipeline now **commits segments using the new Segment Contract** instead of the old segment model. The `reason` is `'endpoint'`.
- **Offline STT with segmentation:** `OfflineAudioBuffer + SegmentationEngine → per-segment OfflineSTT → OfflineTextBuffer`. Uses `SpeechEnergySilencePolicy` or `SpeechVadModelPolicy`. Avoids OOM for long audio files.
- **Cross-domain linkage:** When offline STT runs per-segment, each `(speechSegment, textSegment)` pair produces a `SegmentLink` with `linkType: 'stt_produced'`.

### Migration Steps

1. Update streaming STT pipeline to create `TextSegment` instead of old segment format.
2. Map existing endpoint events to `reason: 'endpoint'`, `source: 'segmentation_engine'`.
3. Add `segmentation` option to offline STT API: `stt.transcribe(audio, text, { segmentation })`.
4. Implement offline STT orchestration using `runOfflineAudioPipeline` (Sub-Plan 04).
5. Per-segment: extract audio slice → create temp OfflineAudioBuffer → transcribe → collect text.
6. **Create `SegmentLink`** for each (speech input segment → text output segment) pair with `linkType: 'stt_produced'`.
7. Merge per-segment transcriptions into final OfflineTextBuffer.
8. Return `SegmentLinkMap` alongside text output (optional, when segmentation active).
9. Test: compare full-run vs. segmented-run transcription quality.

### Phase 2 Progress (Current)

- Completed: Streaming STT endpoint commits now carry Segment Contract metadata (`reason: 'endpoint'`, `source: 'segmentation_engine'`, created-at timestamp) on Android and iOS.
- Completed: `speech_vad_model` now uses a real VAD runtime path for live segmentation (no silent fallback to energy evaluator when selected).
- Completed: Offline `speech_vad_model` segmentation runs chunked over offline audio slices (no full-buffer preload requirement).
- Completed: `stt.transcribe(audio, textOut, options)` supports segmented offline mode and returns structured orchestration result (`status`, counts, skips, timing, optional `linkMap`).
- Completed: Segmented offline STT writes `stt_produced` links for each `(speechSegment, textSegment)` pair.
- Completed: Native bridge method `populateOfflineTextBufferIfEmpty` added to preserve existing target-buffer semantics in segmented flow.
- Completed: Parity-Validierung (automatisiert: relevante Jest-Suites inkl. `segmentation-engine-vad.test.ts`; manuell: Abgleich Implementierung vs. Phase-2-Plan und Sub-05).

### SegmentLink Integration

When segmented offline STT runs, the orchestrator:
- Creates a `SegmentLinkMap` at the start.
- For each segment processed: `addSegmentLink(linkMap, { textSegmentId, speechSegmentId, linkType: 'stt_produced' })`.
- Returns the linkMap in the result, giving the SDK user source attribution for free.

This is **automatically available** because `SegmentLink` types are defined in Phase 1 (Sub-Plan 01). No extra work needed beyond calling `addSegmentLink()` inside the orchestration loop.

### Equivalence

**Approximate.** Segmented offline STT loses cross-segment context. Mitigation: overlap samples at boundaries, pass as context prefix (model-dependent).

### Breaking Changes

- Segment model shape changes (new fields, `domain` discriminator).
- No functional breaking change for streaming STT users — they see the same `onSegment` events with richer metadata.
- New: `SegmentLinkMap` optionally returned from segmented offline STT.

---

## Feature 2: TTS (Text-to-Speech)

### Current State

- **Offline TTS:** Single-shot `OfflineTTS` on full `OfflineTextBuffer` → `OfflineAudioBuffer`.
- **Streaming TTS (incremental):** Custom `IncrementalStreamingTTS` engine that chunks text internally, runs offline TTS per chunk, streams audio output. **Has its own segmentation logic.**

### Target State

- **Offline TTS:** Unchanged for small inputs (mode='off'). For large text, use segmentation: `OfflineTextBuffer + SegmentationEngine → per-segment OfflineTTS → OfflineAudioBuffer`.
- **Streaming TTS:** Replace `IncrementalStreamingTTS` with `LiveTextBuffer + SegmentationEngine(auto) → per-segment OfflineTTS → LiveAudioBuffer`. The Segmentation Engine decides text chunk boundaries; TTS runs offline per chunk.
- **Cross-domain linkage:** Each text segment → synthesized audio segment pair produces a `SegmentLink` with `linkType: 'tts_produced'`.

### Migration Steps

1. Add `segmentation` option to offline TTS API.
2. Implement offline TTS orchestration using `runOfflineTextToAudioPipeline`:
   - Segment text → per-segment TTS → accumulate audio in LiveAudioBuffer → transfer to Offline.
3. **Create `SegmentLink`** for each (text input segment → audio output segment) pair with `linkType: 'tts_produced'`.
4. Implement streaming TTS orchestration:
   - `LiveTextBuffer` with `TextSyntheticAutoPolicy` (or `TextPunctuationAssistedPolicy`).
   - On `onSegment` → run offline TTS on segment text → append audio to output `LiveAudioBuffer`.
   - Create `SegmentLink` for each segment pair.
5. **Remove `IncrementalStreamingTTS`** and all its custom chunking logic.
6. Update public API: `createStreamingTTS` now internally uses Segmentation Engine.
7. Return `SegmentLinkMap` from TTS APIs (enables playback tracking, highlight-while-speaking).
8. Test parity: latency, quality, abort behavior.

### SegmentLink Integration

TTS is the most natural producer of `tts_produced` links:
- **Offline segmented TTS:** Each text segment N → audio segment N. The linkMap gives downstream consumers (playback UI, subtitle overlay) the mapping for free.
- **Streaming TTS:** Each committed text segment → synthesized audio chunk. The linkMap grows as segments are processed, enabling real-time "highlight the sentence being spoken" UX.

### TTS Incremental Removal — Prerequisites (Gates)

| Gate | Criteria |
|---|---|
| **Parity** | Segmented TTS latency ≤ incremental TTS latency for typical inputs |
| **Contract** | SegmentationConfig + TextSyntheticAutoPolicy stable |
| **Ops** | Flush/reset/finalize behavior matches or improves |

### Equivalence

**Approximate.** Segment boundaries affect prosody. Mitigation: sentence-boundary-aligned segmentation (prefer natural breaks).

### Breaking Changes

- `createIncrementalStreamingTTS` removed.
- `createStreamingTTS` API may change (now accepts `segmentation` config).
- Internal: entire TTS incremental engine code deleted.
- New: `SegmentLinkMap` returned from TTS APIs.

---

## Feature 3: Punctuation

### Current State

- **Offline Punctuation:** Already implemented and public (`createOfflinePunctuation`).
- **Streaming Punctuation:** Not implemented yet.
- sherpa-onnx has `OfflinePunctuationConfig` and `OnlinePunctuationConfig`.

### Target State

- **Offline Punctuation:** `OfflineTextBuffer₁ → OfflinePunctuation → OfflineTextBuffer₂`. With optional segmentation for large texts.
- **Streaming Punctuation:** `LiveTextBuffer₁ + SegmentationEngine → per-segment OfflinePunctuation → LiveTextBuffer₂`. Segments are punctuated as they are committed.

### Migration Steps

1. Add `segmentation` option to existing offline punctuation API.
2. Implement streaming punctuation:
   - LiveTextBuffer₁ with auto segmentation.
   - On segment commit → run offline punctuation on segment text → commit result to LiveTextBuffer₂.
3. Implement `TextPunctuationAssistedEvaluator` for bidirectional integration (punctuation model output feeds back into segmentation decisions for downstream features).

### Equivalence

**Approximate.** Punctuation decisions depend on sentence context. Segmentation may cut sentences at suboptimal points. Mitigation: overlap characters at boundaries.

### Breaking Changes

- New public API (no existing API to break).

---

## Feature 4: Enhancement (Speech Denoising)

### Current State

- **Offline Enhancement:** `OfflineAudioBuffer₁ → OfflineEnhancement → OfflineAudioBuffer₂`. Full buffer in memory.
- **Streaming Enhancement:** Frame-drain based. Reads from `LiveAudioBuffer` via cursor, processes frame-by-frame, writes to output `LiveAudioBuffer`. **No segmentation concept.**

### Target State

- **Offline Enhancement with segmentation:** `OfflineAudioBuffer₁ + SegmentationEngine → per-segment OfflineEnhancement → OfflineAudioBuffer₂`. Prevents OOM for large files.
- **Streaming Enhancement:** Keeps frame-drain execution. Uses `ContinuousFramesPolicy`. Optional coarse checkpoints for observability. **Not segment-per-frame.**

### Architecture Rule

Enhancement uses the unified segmentation contract at the API level but retains its continuous execution model internally. See Spec § "Enhancement and Segmentation."

### Migration Steps

1. Completed: `enhance(audioIn, audioOut, options?)` accepts `segmentation`, recovery, progress, and overlap options while preserving the caller-owned `audioOut`.
2. Completed: segmented offline enhancement uses `runOfflineAudioPipeline` with per-segment `enhanceOfflineAudioBuffers`, LiveAudioBuffer accumulation, final transfer, and `populateOfflineAudioBufferIfEmpty(audioOut, orchestratorOutput)`.
3. Completed: streaming enhancement optionally attaches `continuous_frames` before native frame-drain startup and detaches on stop/completion. Frame-drain execution is unchanged.
4. Completed: Android and iOS `continuous_frames` live engines emit checkpoint commits only; `segmentOfflineBuffer(..., { evaluator: 'continuous_frames' })` rejects with `POLICY_INVALID_FOR_OFFLINE`.
5. Completed: offline energy/VAD segmentation reads audio in slices for the segmented path; no full-file PCM vector is materialized by the segmentation/orchestration path.
6. Completed: tests cover single-shot vs segmented enhancement, recovery/populate behavior, continuous-frame attach/offline reject, and audio orchestrator behavior.

### Phase 3 Progress (Completed)

- Public API: `EnhancementEngine.enhance(audioIn, audioOut, options?)` returns `EnhancementResult` with status/counts/skips/timing.
- Native bridge: `populateOfflineAudioBufferIfEmpty(target, source)` atomically adopts source storage into an empty caller target and consumes the source handle.
- Offline segmented path: default policy is `speech_energy_silence`; `abort`, `skip`, `retry`, and `partial_result` are delegated to `OrchestrationSession`.
- Streaming path: `segmentation.policy.evaluator = 'continuous_frames'` is supported for checkpoints only; non-continuous streaming policies are rejected by the Enhancement wrapper.
- Memory audit: one-shot Enhancement may still use native full-buffer model input by design, but segmented offline orchestration and native offline segmentation loops operate on slices/chunks. Streaming remains frame-drain and does not materialize full PCM.

### Equivalence

**Approximate.** Enhancement models may produce artifacts at segment boundaries. Mitigation: overlap N ms at boundaries, cross-fade overlap region.

### Breaking Changes

- `segmentation`/recovery/options parameter added to offline API; existing `(audioIn, audioOut)` call shape remains valid.
- Streaming: optional `segmentation` parameter added; frame-drain behavior is preserved.

---

## Feature 5: Alignment

### Current State

- **Offline Alignment:** `alignTextToAudio(text, audio)`. Single-shot offline.
- **Fake-Live Alignment:** Manual orchestration — chunk-/segment-wise offline alignment, merge results. **Custom segmentation logic.**

### Target State

- **Offline Alignment:** Unchanged for small inputs.
- **Fake-Live Alignment:** `LiveTextBuffer + LiveAudioBuffer + SegmentationEngine → per-segment OfflineAlignment → LiveSegmentBuffer`. The Segmentation Engine handles text/audio segmentation; alignment runs per segment.
- **Cross-Domain Linkage:** A first-class `SegmentLinkMap` tracks which text segments correspond to which speech segments.

### Migration Steps

1. Add `segmentation` option to alignment API.
2. Implement fake-live alignment orchestration:
   - Segmentation produces text + speech segments with linkage.
   - Per linked pair: extract text + audio slices → offline alignment → merge timing.
3. Remove custom segmentation logic from alignment fake-live code.
4. Use `SegmentLinkMap` (from Sub-Plan 01) with `linkType: 'alignment'` for each aligned pair.

---

### Cross-Domain Linkage

> **Types are defined in Sub-Plan 01 (§ Cross-Domain Linkage).** Alignment is a **consumer** of these core types, not their owner.

Alignment creates `SegmentLink` instances with `linkType: 'alignment'` after the alignment model produces timing results. The `confidence` field reflects alignment model confidence per link.

Key points (from Sub-Plan 01):
- `SegmentLink` is feature-agnostic — STT uses `stt_produced`, TTS uses `tts_produced`, Alignment uses `alignment`.
- `SegmentLinkMap` supports N:M cardinality (chorus/refrain = 1:N, multi-speaker = N:1).
- Bidirectional query: `getSpeechSegmentsForText()` / `getTextSegmentsForSpeech()`.
- Lifecycle: always in-memory, `releaseSegmentLinkMap()` to free.

---

### Cross-Domain Segmentation Strategies

Alignment needs coordinated segmentation across text and audio. Three strategies are supported:

#### Strategy 1: Text-Driven (recommended default)

```
1. Segment text (sentence/punctuation boundaries)
2. For each text segment, estimate corresponding audio range:
   a. Proportional mapping: textOffset/textLength * audioDuration
   b. If VAD available: snap to nearest VAD boundary
3. Create SegmentLink for each (text, speech) pair
4. Run alignment per linked pair
```

**When to use:** Text has reliable structure (sentences, paragraphs). Audio is continuous (no long silences). Most common case (TTS output alignment, scripted content).

#### Strategy 2: Speech-Driven

```
1. Segment audio (VAD or energy/silence)
2. For each speech segment, estimate corresponding text range:
   a. Proportional mapping: speechOffset/speechDuration * textLength
   b. If STT available: use STT output to find text match
3. Create SegmentLink for each (text, speech) pair
4. Run alignment per linked pair
```

**When to use:** Audio has clear speech/silence patterns. Text may be poorly structured (long paragraphs, no punctuation). Conversational audio with pauses.

#### Strategy 3: Joint (dual-domain)

```
1. Segment text AND audio independently
2. Build initial link map using proportional time mapping
3. Refine links using anchor points:
   a. VAD boundaries as hard anchors
   b. STT partial matches as soft anchors
4. Run alignment per linked pair
5. Post-process: merge/split links where alignment confidence is low
```

**When to use:** Both text and audio have good structure. Highest quality but most complex. Research/production workflows.

#### Strategy Configuration

```typescript
interface AlignmentSegmentationConfig extends SegmentationConfig {
  /** Cross-domain strategy */
  crossDomainStrategy: 'text_driven' | 'speech_driven' | 'joint';

  /** Text segmentation policy (used in text-driven and joint) */
  textPolicy?: SegmentationPolicy;

  /** Speech segmentation policy (used in speech-driven and joint) */
  speechPolicy?: SegmentationPolicy;

  /** Proportional mapping tolerance (ms) for initial link estimation */
  proportionalToleranceMs?: number;

  /** Snap to VAD boundaries when available */
  snapToVad?: boolean;
}
```

---

### Alignment Output: SegmentLinkMap as First-Class Result

The alignment API returns a `SegmentLinkMap` alongside the usual alignment output:

```typescript
interface AlignmentResult {
  /** Alignment timing output (existing) */
  segmentBuffer: OfflineSegmentBufferRef;

  /** Cross-domain link map (new) */
  linkMap: SegmentLinkMapRef;

  /** Text segments used */
  textSegments: OfflineSegmentBufferRef;

  /** Speech segments used */
  speechSegments: OfflineSegmentBufferRef;
}
```

This gives the SDK user full access to:
- The alignment timing data (existing)
- Which text maps to which audio (new, via link map)
- The individual segments in both domains (new)

---

### Lifecycle & Memory

| Property | Value |
|---|---|
| Storage | Always in-memory (link data is tiny) |
| Typical size | < 100 KB even for thousands of links |
| Thread safety | Read-only after creation in alignment flows; lock-protected for mutable use |
| Cleanup | `releaseSegmentLinkMap(linkMapId)` frees native memory |
| Spool | None (not needed for metadata this small) |

---

### Equivalence

**Approximate.** Timing drift at segment boundaries. Mitigation: merge pass to smooth timing at joints.

### Breaking Changes

- `segmentation` parameter added to alignment API (additive).
- `AlignmentResult` now includes `linkMap` (additive).
- Fake-live internal logic rewritten (no public API change).

---

## Feature 6: VAD

### Current State

- **Streaming VAD:** Real streaming via sherpa-onnx `VadModelConfig`. Produces `LiveSegmentBuffer` with speech segments.
- **Offline VAD:** Run streaming VAD on offline audio (process all at once).

### Target State

- **Streaming VAD:** VAD is a **source** of speech segments, not a consumer. It directly integrates as `SpeechVadModelEvaluator` within the Segmentation Engine.
- **Offline VAD:** Uses `segmentOfflineBuffer(audioBuffer, vadModelPolicy)` → `OfflineSegmentBuffer`.

### Migration Steps

1. Implement `SpeechVadModelEvaluator` that wraps the existing VAD pipeline.
2. VAD pipeline output → evaluator → segment commit.
3. Existing `LiveSegmentBuffer` is populated via the new contract.
4. Offline: `segmentOfflineBuffer` with `vad_model` policy reuses same evaluator in one-shot mode.
5. Test: verify VAD segment boundaries match existing behavior.

### Equivalence

**Exact.** VAD is inherently segment-producing. The new contract is a wrapper, not a change in boundary logic.

### Breaking Changes

- Segment model shape changes (new fields).
- No functional change in VAD boundary detection.

---

## Migration Order

| Phase | Features | Rationale |
|---|---|---|
| **Phase 1a** | Core Types & Linkage (Sub-Plan 01) | TypeScript, Kotlin, C++ Datentypen (Segment, SegmentLink) + Serialisierung. |
| **Phase 1b** | Storage & Write APIs (Sub-Plan 03) | Symmetric Write API, `getSegmentBuffer()`, Event-Payloads. |
| **Phase 1c** | Orchestration & Transfer (Sub-Plan 04) | Zero-Copy Transfer, Lifecycle Management, Error Recovery. |
| **Phase 1d** | Engine Core (Sub-Plan 02) | Native Evaluatoren, Offline-Segmentation Loop. |
| **Phase 2** | VAD + STT (+ `stt_produced` links) | VAD is a source; STT is the primary consumer. STT creates first SegmentLinks. |
| **Phase 3** | Enhancement (offline segmented) | High OOM impact. Validates audio orchestration + transfer. |
| **Phase 4** | Punctuation | New public engine. Uses text segmentation. |
| **Phase 5** | TTS (remove incremental, + `tts_produced` links) | Highest risk. TTS creates links for playback tracking. |
| **Phase 6** | Alignment (fake-live, + `alignment` links) | Most complex (cross-domain strategies). Benefits from all prior phases. |

> **Note:** `SegmentLink` and `SegmentLinkMap` types are implemented in **Phase 1** as part of Sub-Plan 01. Features simply call `addSegmentLink()` with their respective `linkType` when they start producing cross-domain results (Phase 2+).

---

## Validation Checklist (per feature)

- [x] New Segment Contract types used (Phase 3 Enhancement uses shared `SegmentationPolicy` and segment accessors)
- [x] Old segment model removed/avoided for Enhancement migration path
- [x] Segmentation config accepted in Enhancement offline and streaming APIs
- [x] Auto-segmentation works with appropriate offline policy (`speech_energy_silence`)
- [x] Manual commit remains a Segment Engine capability; Enhancement Phase 3 uses auto/offline orchestration and continuous streaming checkpoints
- [x] No segmentation (`mode='off'`) works (full one-shot Enhancement)
- [x] onSegment events emitted correctly for Streaming `continuous_frames` checkpoints
- [x] Pull API returns correct checkpoint segments (`reason: 'policy_checkpoint'`)
- [x] Spool replay/transfer reconstructs segmented Enhancement output via LiveAudioBuffer accumulator
- [x] Equivalence documented and tested as approximate with overlap support
- [x] Old segmentation code removed (**N/A for Enhancement**: there was no legacy custom segmentation pipeline to retire; streaming remained frame-drain by design)
- [x] **SegmentLinkMap** created when cross-domain processing active (**N/A for Enhancement**: single-domain audio->audio flow, no cross-domain linkage)
- [x] **SegmentLinks** correctly reference text ↔ speech segment IDs (**N/A for Enhancement**)
- [x] Bidirectional query returns correct links (**N/A for Enhancement**)
