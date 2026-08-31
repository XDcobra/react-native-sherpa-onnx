# Live Overload — Implementation Overview

> Companion implementation plan for the design note
> [`offline-stt-live-pipeline-mandatory-segmentation.md`](./offline-stt-live-pipeline-mandatory-segmentation.md).
> Mirrors the structure of the segmentation engine migration
> ([`docs/migration/segmentationEngine/segmentation_engine_overview.md`](../segmentationEngine/segmentation_engine_overview.md)).

## Scope

Add a **live-pipeline overload** to every existing offline engine that today has both an offline batch path and (where applicable) a separate streaming engine, so that **offline weights can be consumed live** with a **mandatory `segmentation.policy`** — without introducing a third engine factory and without changing the existing batch overload.

Per the design note (§5), this rollout covers four features:

| Feature | Decision (§5.1) | New live overload |
|---|---|---|
| **STT** | (a) STT template | `engine.transcribe(LiveAudio, LiveText, { segmentation })` |
| **Punctuation** | (a) STT template | `engine.punctuate(LiveText, LiveText, { segmentation })` |
| **TTS** | (a) STT template + post-impl dedup | `engine.synthesize(LiveText, LiveAudio, { segmentation })` |
| **Enhancement** | (b) STT template **with restrictions** | `engine.enhance(LiveAudio, LiveAudio, { segmentation: { policy: continuous_frames } })` |
| **Separation** | (b) STT template **with restrictions** | `engine.separate(LiveAudio, LiveAudio[], { segmentation: { policy: continuous_frames } })` |
| VAD / Alignment / Diarization | (c) / (d) — no live overload | — |

---

## Files in this folder

All paths under `docs/migration/liveOverload/`:

| File | Content |
|---|---|
| [offline-stt-live-pipeline-mandatory-segmentation.md](./offline-stt-live-pipeline-mandatory-segmentation.md) | **Design note (v1)** — problem statement, options A/B/C, per-feature decisions, partials/commits, validation, error code. **Already complete.** |
| [sub-01-foundation-contract.md](./sub-01-foundation-contract.md) | **Cross-feature contract** — TypeScript types (`<Feature>LivePipelineOptions`, `<Feature>PipelineHandle` reuse), shared validation helper, the `LIVE_OFFLINE_SEGMENTATION_REQUIRED` error code. |
| [sub-02-shared-worker-base.md](./sub-02-shared-worker-base.md) | **Shared native worker** — `OfflineLivePipelineWorker` base on Android (Kotlin) + iOS (Obj-C++/C++); drain loop, flush, stop, completion-event integration; segmentation-engine commit hook. |
| [sub-03-stt-live-overload.md](./sub-03-stt-live-overload.md) | **STT live overload (reference feature)** — JS shape + TurboModule `startSttOfflineLivePipeline` + Kotlin/Obj-C++ implementations, tests. |
| [sub-04-punctuation-live-overload.md](./sub-04-punctuation-live-overload.md) | **Punctuation live overload** — `OfflinePunctuationEngine.punctuate(LiveText, LiveText, …)` reusing offline CT-Transformer weights via segmentation. |
| [sub-05-tts-live-overload.md](./sub-05-tts-live-overload.md) | **TTS live overload** — `TtsEngine.synthesize(LiveText, LiveAudio, …)` reusing offline TTS weights via segmentation. (Track A only — dedup is sub-08.) |
| [sub-06-enhancement-live-overload.md](./sub-06-enhancement-live-overload.md) | **Enhancement live overload (restricted)** — `EnhancementEngine.enhance(LiveAudio, LiveAudio, …)` with `policy.evaluator === 'continuous_frames'` enforced. |
| [sub-07-cleanup-and-test-harness.md](./sub-07-cleanup-and-test-harness.md) | **Cleanup & cross-feature test matrix** — example app integration, parity audit, Jest matrix per feature, doc updates. |
| [sub-08-streaming-tts-dedup.md](./sub-08-streaming-tts-dedup.md) | **Streaming TTS dedup (post-implementation)** — explicitly deferred per design §7.5; thin alias / deprecation path / removal milestone. |

---

## Architecture (target)

```mermaid
flowchart TB
    subgraph JS["JavaScript layer"]
        OPT["`<Feature>LivePipelineOptions`<br/>(segmentation REQUIRED)"]
        VAL["`validateLiveOfflinePipelineOptions(...)`<br/>throws LIVE_OFFLINE_SEGMENTATION_REQUIRED"]
        ENG["`<Feature>Engine` (offline)<br/>method overload: live in / live out"]
        OPT --> VAL --> ENG
    end

    subgraph Native["Native layer (Android + iOS)"]
        SEGREG[("SegmentationEngineRegistry")]
        WORKER["OfflineLivePipelineWorker (shared)<br/>drain · flush · stop · completion · pipelineId"]
        PIPEREG[("StreamingPipelineRegistry<br/>(unchanged, reused)")]

        SEGREG -- "newly committed segments" --> WORKER
        WORKER -- "register / completion event" --> PIPEREG
    end

    subgraph PerFeature["Per feature override"]
        STT["onSegmentCommitted →<br/>OfflineRecognizer per segment"]
        TTS["onSegmentCommitted →<br/>OfflineTts per segment"]
        PUNC["onSegmentCommitted →<br/>OfflinePunctuation per segment"]
        ENH["onSegmentCommitted →<br/>OfflineSpeechEnhancement per chunk<br/>(continuous_frames only)"]
    end

    ENG -- "TurboModule call<br/>start<Feature>OfflineLivePipeline" --> WORKER
    WORKER --> STT & TTS & PUNC & ENH
    PIPEREG -- "streamingPipelineCompleted" --> JS
```

Mental model:

- The **offline engine factory (`createX`) stays unchanged** — same init flow, same model assumptions.
- The **streaming engine factory (`createStreamingX`) stays unchanged** — same online-decoder semantics. (Streaming TTS deduplication is a separate, deferred phase.)
- The new overload is **purely additive** on the offline engine: live-buffer in / live-buffer out, with `segmentation` mandatory.
- Inside native, **one shared worker base** handles all generic pipeline plumbing; each feature only implements `onSegmentCommitted(...)`.

---

## Pipeline modes after this rollout

| # | Mode | Flow | Where introduced |
|---|---|---|---|
| 1 | Offline batch (off) | `Offline → Engine → Offline` | Today (unchanged) |
| 2 | Offline batch (auto) | `Offline + SegEngine → Engine → Offline` | Segmentation-engine migration (already shipped) |
| 3 | Streaming with online decoder | `Live → online decoder → Live` | Today (unchanged) |
| 4 | Live TTS (offline weights, segmentation-driven) | `LiveText + SegEngine → OfflineTts → LiveAudio` | `createTTS().synthesize(LiveText, LiveAudio, { segmentation })` |
| 5 | **Live overload on offline engine** | `Live + SegEngine → offline engine per segment → Live` | **NEW — this rollout** |

Mode 5 is the contract this rollout adds.

---

## Migration order (phases)

Each phase ships independently and is verified in isolation before moving to the next. Phases 2–5 reuse the foundation from Phase 1 with **zero further changes** to the shared layer.

| Phase | Sub-plan | Scope | Acceptance |
|---|---|---|---|
| **Phase 1a** | [sub-01](./sub-01-foundation-contract.md) | Cross-feature TS contract: `<Feature>LivePipelineOptions`, `validateLiveOfflinePipelineOptions(...)`, `LIVE_OFFLINE_SEGMENTATION_REQUIRED` error class, no native changes yet. | Tests: validator unit tests cover all rejection paths (missing policy, `mode: 'off'`, `mode: 'manual'`, unsupported evaluator). |
| **Phase 1b** | [sub-02](./sub-02-shared-worker-base.md) | Native shared worker base (Kotlin + Obj-C++/C++), segmentation-engine commit hook, drain/flush/stop/completion-event reuse. **No public-facing JS overload yet** — base only, validated via STT in Phase 2. | Compiles on Android + iOS; STT integration in Phase 2 verifies the base end-to-end. |
| **Phase 2** | [sub-03](./sub-03-stt-live-overload.md) | STT live overload as the reference implementation. New `transcribe(LiveAudio, LiveText, options)` overload + `startSttOfflineLivePipeline` TurboModule. | Golden Jest test: offline weights + live audio → committed text segments arrive on `LiveTextBuffer`. Negative test: missing policy → `LIVE_OFFLINE_SEGMENTATION_REQUIRED`. |
| **Phase 3** | [sub-04](./sub-04-punctuation-live-overload.md) | Punctuation live overload. New `punctuate(LiveText, LiveText, options)` overload on `OfflinePunctuationEngine` (CT-Transformer weights). | Golden Jest test + negative test pattern as Phase 2; reuses Phase 1 base unchanged. |
| **Phase 4** | [sub-05](./sub-05-tts-live-overload.md) | TTS live overload (Track A). New `synthesize(LiveText, LiveAudio, options)` overload on `TtsEngine`. **No dedup with `createStreamingTTS` yet** (sub-08). | Golden Jest test + negative test; verifies parity with `createStreamingTTS`-style output for the same `text_synthetic_auto` policy. |
| **Phase 5** | [sub-06](./sub-06-enhancement-live-overload.md) | Enhancement live overload (restricted). New `enhance(LiveAudio, LiveAudio, options)` overload on `EnhancementEngine`; policy is **enforced** to `continuous_frames`. | Golden Jest test + negative tests: missing policy AND non-`continuous_frames` policy both throw `LIVE_OFFLINE_SEGMENTATION_REQUIRED`. |
| **Phase 6** | [sub-07](./sub-07-cleanup-and-test-harness.md) | Cleanup, cross-feature parity audit, example-app live screen wiring, doc updates (`stt-offline.md`, `tts-offline.md`, etc.). | All sub-plan acceptance items checked; CI green on Android + iOS; example app live-pipeline screen demoes the overload for at least STT (+1 other feature). |
| **Phase 7** | [sub-08](./sub-08-streaming-tts-dedup.md) | Streaming TTS dedup and hard removal. Legacy `createStreamingTTS` path removed; live pipelines use `createTTS` overload only. | Breaking minor rollout complete; docs/tests/native worker cleanup complete. |

---

## Design decisions (anchored from the design note)

> [!IMPORTANT]
> - **Single overload per feature, on the offline engine.** No third factory, no flag on the streaming engine.
> - **Mandatory segmentation policy.** TypeScript already enforces presence; runtime validator throws `LIVE_OFFLINE_SEGMENTATION_REQUIRED` for JS callers.
> - **Commit-only output.** No `onPartial` on the live overload — partials are a true-streaming contract (design §7.1).
> - **Shared native worker base, exactly once.** Per-feature work is `onSegmentCommitted(...)` only — drain loop, flush, stop, completion event, registry hand-off are shared (design §7.4).
> - **Reused public types where they exist.** `<Feature>PipelineHandle`, `StreamingPipelineStatus`, `streamingPipelineCompleted` event — all unchanged. The overload returns the **same handle types** as the streaming engine.
> - **Pre-release, clean-cut.** No deprecated leftovers remain after sub-08 hard removal.

## Cross-feature error contract

| Code | Where it fires | Message template |
|---|---|---|
| `LIVE_OFFLINE_SEGMENTATION_REQUIRED` | Live overload validator (sub-01) | `LIVE_OFFLINE_SEGMENTATION_REQUIRED: live offline pipelines require segmentation.policy (mode must not be "off"). Provide a valid policy (e.g. speech_energy_silence, text_synthetic_auto, or continuous_frames for enhancement).` |
| `LIVE_OFFLINE_SEGMENTATION_REQUIRED` *(reused)* | Enhancement live overload when `policy.evaluator !== 'continuous_frames'` (sub-06) | `LIVE_OFFLINE_SEGMENTATION_REQUIRED: live enhancement supports only continuous_frames policy; received <evaluator>.` |
| `STREAMING_PIPELINE_ERROR` *(existing)* | Native worker fault, propagated through completion event | unchanged |

> Per the design note, **one** cross-feature code (`LIVE_OFFLINE_SEGMENTATION_REQUIRED`) owns the mandatory-policy contract for **all** features that ship a live overload. Feature-specific subcodes are explicitly avoided.

---

## What is **not** in scope

- **VAD / Alignment / Diarization** — see design §5.1 (decisions c / d). No live overload, no native changes here. (**Separation** live overload is shipped — decision b, like Enhancement.)
- **Online decoder enhancements** — `createStreamingX` factories stay byte-for-byte unchanged.
- **Public API for `OfflineLivePipelineWorker`** — the worker base is internal native infrastructure. JS users only see the per-feature overload.
- **Streaming TTS dedup** — phase 7 / sub-08 only. Not part of the first shipping slice.

---

## Definition of done (rollout-wide)

- [ ] Phase 1a + 1b green on CI (validator unit tests, native build green Android + iOS).
- [ ] Phase 2–5 each ship a golden Jest test (positive path) + negative test (missing policy / unsupported evaluator).
- [ ] All four features return their **existing** `<Feature>PipelineHandle` from the live overload.
- [ ] Streaming pipeline registry events (`streamingPipelineCompleted`) deliver consistent payloads for the new pipelines.
- [ ] Doc set updated: `stt-offline.md`, `tts-offline.md` (where it exists), `enhancement-offline.md`, `punctuation.md` — each gains a "Live overload" section pointing back to the design note.
- [ ] Example app live-pipeline screen demoes at least STT live overload + one of (TTS / punctuation / enhancement) (sub-07).
- [ ] No legacy adapter or deprecated alias remains after sub-08 hard removal.
