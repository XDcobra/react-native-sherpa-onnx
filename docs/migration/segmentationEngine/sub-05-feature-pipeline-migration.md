# Sub-Plan 05: Feature Pipeline Migration

## Status
- **Phase 2 (STT + VAD + `stt_produced`):** Completed — Implementierung und Parity-Check (Plan `phase-2-vad-stt`, Jest: `segment-api`, `transcribe-segmented`, `offline-orchestrator`) erfüllt.
- **Phase 3 (Enhancement offline segmentiert + Streaming `continuous_frames`):** Completed — Offline Enhancement nutzt optional den Phase-1c-Audio-Orchestrator, befüllt das Caller-`audioOut` via `populateOfflineAudioBufferIfEmpty`, Streaming Enhancement kann `continuous_frames` als Checkpoint-only Attach nutzen, und native Offline-Segmentation bleibt chunked.
- **Phase 4 (Punctuation offline segmentiert + Streaming `OnlinePunctuation`):** Completed — Offline Punctuation bleibt `OfflineTextBuffer -> OfflineTextBuffer` und nutzt optional den Text-Orchestrator; Streaming Punctuation ist neu, nutzt echtes `OnlinePunctuation` mit `LiveTextBuffer -> LiveTextBuffer`; `TextPunctuationAssistedEvaluator` unterstützt `punctuationInstanceId`.
- **Phase 5 (TTS, vier Modi + Incremental-Removal):** Completed — Offline one-shot bleibt Default, segmentierter Offline-Pfad nutzt `runOfflineTextToAudioPipeline`/`runOfflineTtsPipeline`, Streaming unterstützt `mode:'off'` und `mode:'auto'` via Segmentation-Engine-Attach, `tts_produced` Links werden im segmentierten Offline-Pfad erzeugt, und `src/tts/incremental/**` wurde entfernt.
- **Phase 6 (Alignment + `alignment` links):** Completed — Alignment ist auf dem aktuellen `AlignmentEngine`-Pfad (`accurate` mit `mappingStrategy: asr_mediated | chunked_forced_ctc`) integriert; `SegmentLinkMap` wird erzeugt/genutzt (`linkType: 'alignment'`), und Legacy-Fake-Live-Pfade sind nicht mehr aktiv.
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
- **Model capability note:** sherpa-onnx currently exposes `OfflineTTS` APIs (with callback-style chunk emission), but no separate `OnlineTTS` model class/config equivalent to ASR `OnlineRecognizer`.

### Target State

- **Offline TTS:** Unchanged for small inputs (mode='off'). For large text, use segmentation: `OfflineTextBuffer + SegmentationEngine → per-segment OfflineTTS → OfflineAudioBuffer`.
- **Live TTS pipeline (offline-model-backed):** Replace `IncrementalStreamingTTS` with `LiveTextBuffer + SegmentationEngine(auto) → per-segment OfflineTTS → LiveAudioBuffer`. The Segmentation Engine decides text chunk boundaries; TTS inference remains `OfflineTTS` per segment/chunk. This is a live orchestration mode, **not** a separate online TTS model backend.
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
6. Update public API: live TTS entry (e.g. `createStreamingTTS`) now internally uses Segmentation Engine orchestration with `OfflineTTS` per segment (no implication of `OnlineTTS` model support).
7. Return `SegmentLinkMap` from TTS APIs (enables playback tracking, highlight-while-speaking).
8. Test parity: latency, quality, abort behavior.

### SegmentLink Integration

TTS is the most natural producer of `tts_produced` links:
- **Offline segmented TTS:** Each text segment N → audio segment N. The linkMap gives downstream consumers (playback UI, subtitle overlay) the mapping for free.
- **Live TTS pipeline:** Each committed text segment → synthesized audio chunk. The linkMap grows as segments are processed, enabling real-time "highlight the sentence being spoken" UX.

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
- Live TTS API (e.g. `createStreamingTTS`) may change (now accepts `segmentation` config) but remains offline-model-backed internally.
- Internal: entire TTS incremental engine code deleted.
- New: `SegmentLinkMap` returned from TTS APIs.

### Phase 5 Progress (Completed)

| Mode | API | Status | Notes |
|---|---|---|---|
| 1 | `OfflineTtsEngine.synthesize(..., mode: off/default)` | Completed | Native one-shot path bleibt Default und verhaltensgleich; Rückgabe jetzt `TtsSynthesisResult`. |
| 2 | `OfflineTtsEngine.synthesize(..., mode: auto)` | Completed | Segmentierte Orchestrierung über `runOfflineTextToAudioPipeline` + `runOfflineTtsPipeline`, Caller-`audioOut` via `populateOfflineAudioBufferIfEmpty`. |
| 3 | `StreamingTtsEngine.synthesize(..., mode: off/default)` | Completed | Kein Attach; Pipeline startet direkt mit Caller-committed Segmenten. |
| 4 | `StreamingTtsEngine.synthesize(..., mode: auto)` | Completed | `attachSegmentationEngine` vor Pipeline-Start, detach bei `stop()`/`completed`; nur Text-Evaluatoren erlaubt. |

#### Phase 5 Checklist

- [x] `TtsSynthesisOptions` erweitert um `segmentation` + Recovery/Progress/LinkMap-Felder.
- [x] `TtsSynthesisResult` eingeführt; Offline `synthesize()` liefert Status/Counts/Timing.
- [x] Neuer Pipeline-Helper `runOfflineTextToAudioPipeline` mit Recovery + SegmentMappings.
- [x] Neuer TTS-Orchestrator `runOfflineTtsPipeline` mit Default `text_synthetic_auto` und `getTtsSampleRate()`.
- [x] Segmentierter Offline-Pfad erzeugt `tts_produced` Links pro Segment-Mapping.
- [x] Streaming validiert Buffer-Kinds (`txt_live_*` -> `live_*`).
- [x] Streaming validiert Policies (nur `text_synthetic_auto`/`text_punctuation_assisted`; `punctuationInstanceId` Pflicht für assisted).
- [x] `src/tts/incremental/**` entfernt; keine Legacy-Segmentierung im TTS-Featurepfad.
- [x] Jest-Abdeckung ergänzt: `synthesize-mode1-oneshot`, `synthesize-mode2-segmented`, `synthesize-mode2-linkmap`, `streaming-mode3`, `streaming-mode4-segmentation`, `orchestrate`, plus Orchestrator-Erweiterung in `offline-orchestrator`.

---

## Feature 3: Punctuation

### Current State

- **Offline Punctuation:** Completed and public (`createOfflinePunctuation`), with default one-shot behavior and optional segmented orchestration.
- **Streaming Punctuation:** Completed as `createStreamingPunctuation`, backed by sherpa-onnx `OnlinePunctuation`.
- sherpa-onnx `OfflinePunctuationConfig` and `OnlinePunctuationConfig` are both wired through public API entry points.

### Target State

- **Offline Punctuation:** `OfflineTextBuffer₁ → OfflinePunctuation → OfflineTextBuffer₂`. With optional segmentation for large texts.
- **Streaming Punctuation:** `LiveTextBuffer₁ + optional SegmentationEngine → OnlinePunctuation → LiveTextBuffer₂`. Segments/chunks are punctuated as they are committed, with no Offline/Live buffer mixing.

### Migration Steps

1. Completed: `segmentation` option added to existing offline punctuation API; default remains one-shot.
2. Completed: segmented offline path uses `runOfflineTextPipeline`, per-segment `punctuateOfflineTextBuffers`, final `populateOfflineTextBufferIfEmpty` into caller-owned output.
3. Completed: `StreamingPunctuationEngine` added with `OnlinePunctuation` (CNN-BiLSTM + `bpe.vocab`), `LiveTextBuffer` in/out, generic streaming lifecycle, and optional segmentation attach.
4. Completed: `TextPunctuationAssistedEvaluator` resolves `punctuationInstanceId` against online first, offline second, and rejects missing/invalid instances.
5. Completed: `continuous_frames` remains speech-only; text attach/offline paths reject it via policy validation.

### Equivalence

**Approximate.** Punctuation decisions depend on sentence context. Segmentation may cut sentences at suboptimal points. Mitigation: overlap characters at boundaries.

### Breaking Changes

- `OfflinePunctuateResult` now carries orchestration status/count fields in segmented mode; existing `(textIn, textOut)` calls remain valid and one-shot by default.
- New public streaming API: `createStreamingPunctuation`.

### Phase 4 Progress (Completed)

- TS API: `OfflinePunctuationEngine.punctuate(..., options?)`, `punctuateString(..., options?)`, `runOfflinePunctuationPipeline`, `StreamingPunctuationEngine`, and shared `SegmentationPolicy.punctuationInstanceId`.
- Native Android/iOS: online punctuation init/process/unload, streaming punctuation worker, `startStreamingPunctuationPipeline`, and punctuation-assisted segmentation evaluator.
- Buffer contract: offline APIs accept only `OfflineTextBuffer`; streaming APIs accept only `LiveTextBuffer`. No hybrid OfflinePunctuation-per-live-segment path remains.
- Recovery/parity: segmented offline punctuation delegates `abort`, `skip`, `retry`, and `partial_result` to `OrchestrationSession`; equivalence is approximate because punctuation quality depends on text context and boundary overlap.
- Validation: Jest coverage for segmented offline punctuation, streaming punctuation lifecycle/attach, and punctuation-assisted policy forwarding; Android Kotlin compilation through the example project.

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

- **AlignmentEngine:** `createAlignment().alignTextToAudio(textIn, audioIn, segmentOut, options)` ist der produktive Pfad.
- **`accurate` segmented:** nutzt `mappingStrategy: 'asr_mediated' | 'chunked_forced_ctc'` mit `anchorSegmentBuffer` (speech anchors) aus Segmentation.
- **Linkage:** `SegmentLinkMap` wird mit `linkType: 'alignment'` materialisiert und als Ergebnis verfügbar gemacht.

### Target State

- **Offline one-shot (`accurate` + `segmentation: off`):** bleibt unverändert.
- **Segmented accurate:** `SegmentationEngine` liefert speech anchors; Alignment verarbeitet per-anchor Slices (`asr_mediated` oder `chunked_forced_ctc`) ohne custom fake-live orchestration.
- **Cross-domain linkage:** Für relevante text↔speech-Paare werden `alignment`-Links erzeugt; bidirektionale LinkMap-Queries sind nutzbar.

### Migration Steps

1. `segmentation`-Option in Alignment auf finalen Contract heben (`accurate` + `mode:'auto'` + Strategy-Selector).
2. `SegmentLinkMap` als first-class Artifact durchreichen und für `alignment`-Links nutzen.
3. Keine Reaktivierung von Legacy/Fake-Live-Custompfaden; bei nicht erfüllbaren Contracts deterministisch fehlschlagen.
4. Tests auf LinkMap-Erzeugung, `linkType:'alignment'`, bidirektionale Queries und no-fallback Verhalten absichern.

### Phase 6 Progress (Completed)

- Completed: Alignment nutzt durchgehend den Engine-first Pfad (`createAlignment`/`alignTextToAudio`), kein freestanding/legacy fake-live entry.
- Completed: `asr_mediated` gibt die vom Linker erzeugte `SegmentLinkMap` an den Alignment-Call zurück.
- Completed: `chunked_forced_ctc` materialisiert `SegmentLinkMap` ebenfalls deterministisch und fügt pro geschriebenem Segment `linkType: 'alignment'` hinzu.
- Completed: Fehler auf LinkMap-Materialisierung werden als expliziter Fehler propagiert (kein stiller Fallback auf legacy/custom path).

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
| **Phase 4** | Punctuation | **Completed.** Offline segmented text orchestration, true `OnlinePunctuation` streaming engine, and native punctuation-assisted evaluator. |
| **Phase 5** | TTS (remove incremental, + `tts_produced` links) | **Completed.** Vier Modi implementiert (offline off/auto, streaming off/auto), segmentierter Offline-Orchestrator + LinkMap aktiv, Incremental-Legacy entfernt. |
| **Phase 6** | Alignment (fake-live, + `alignment` links) | Most complex (cross-domain strategies). Benefits from all prior phases. |

> **Note:** `SegmentLink` and `SegmentLinkMap` types are implemented in **Phase 1** as part of Sub-Plan 01. Features simply call `addSegmentLink()` with their respective `linkType` when they start producing cross-domain results (Phase 2+).

---

## Validation Checklist (per feature)

- [x] New Segment Contract types used (Phase 4 Punctuation uses shared `SegmentationPolicy`, text segment accessors, and `punctuationInstanceId`)
- [x] Old segment model removed/avoided for Punctuation migration path
- [x] Segmentation config accepted in Punctuation offline and streaming APIs
- [x] Auto-segmentation works with appropriate offline policy (`text_synthetic_auto`) and optional `text_punctuation_assisted`
- [x] Manual commit remains a Segment Engine capability; Streaming Punctuation consumes committed LiveTextBuffer segments
- [x] No segmentation (`mode='off'`) works (full one-shot OfflinePunctuation and direct streaming pipeline start)
- [x] onSegment events emitted through LiveTextBuffer commits in Streaming Punctuation
- [x] Pull API returns text segments committed by streaming punctuation output
- [x] Spool replay/transfer remains buffer-owned; Punctuation does not introduce cross-buffer storage mixing
- [x] Equivalence documented and tested as approximate with overlap support
- [x] Old segmentation code removed/avoided (**N/A for Punctuation**: no legacy public streaming punctuation existed; the rejected hybrid design is documented)
- [x] **SegmentLinkMap** created when cross-domain processing active (**N/A for Punctuation**: single-domain text->text flow)
- [x] **SegmentLinks** correctly reference text ↔ speech segment IDs (**N/A for Punctuation**)
- [x] Bidirectional query returns correct links (**N/A for Punctuation**)
