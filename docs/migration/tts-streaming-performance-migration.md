# Migration plan: High-performance TTS streaming (binary chunks + stream-to-file)

High-level plan to move streaming TTS from many `samples: number[]` chunk events to a performance-first architecture for long text: **binary chunk delivery**, **fewer JS callbacks**, and **native stream-to-file** when JS PCM is not needed.

Use this document to split the streaming migration into sub-plans and implement incrementally.

---

## 1. Context and goals

### Problem

- Current streaming chunk payloads include `samples: number[]`, which requires per-element marshalling over the bridge.
- Long text means many chunks; even moderate per-chunk overhead accumulates into high CPU, bridge pressure, and GC churn.
- For file export workflows, sending all PCM through JS is unnecessary overhead.

### Goals

- **Primary:** optimize long-text streaming throughput and memory behavior.
- **Public API may break** if needed for performance.
- Prefer **binary block transfer** over `number[]` for chunk payloads.
- Reduce callback frequency by allowing larger native chunk frames.
- Support **native stream-to-file** where JS receives progress/final state only.

### Non-goals (this track)

- Maintaining backwards compatibility for old chunk contracts.
- Solving all alignment redesign concerns in the same effort.
- Waiting for Codegen-native `ArrayBuffer` support in TurboModule specs.

---

## 2. Target architecture (summary)

| Aspect | Today | Target |
|--------|--------|--------|
| Streaming chunk payload | `samples: number[]` (+ internal IDs in payload) | Public chunk exposes only user-relevant fields with binary PCM (`Float32Array`/`ArrayBuffer` view); internal routing IDs stay private |
| Callback cadence | Many small bridge events | Configurable coalescing: fewer, larger chunk callbacks |
| Stream-to-file | Optional but mixed with JS chunk paths | Native-first incremental write path; JS gets progress/end only |
| JS playback path | Often fed from `number[]` | Consume binary chunks directly (`Float32Array`) |
| Export path | JS PCM may be involved | No JS PCM for normal file-export streaming flow |

### Design rules

1. **No element-by-element marshalling** for streaming PCM hot paths.
2. **One clear contract per path**:
   - interactive streaming (binary chunks to JS),
   - export streaming (native writer, progress events),
   - optional PCM materialization only on explicit request.
3. **Public API minimalism:** do not expose internal routing metadata (`instanceId`, `requestId`) in normal chunk callbacks.
4. **Android/iOS behavioral parity** for chunk semantics, ordering, and error handling.

---

## 3. Workstreams (sub-plan topics)

### 3.1 Streaming public API break: binary chunk contract

- Replace `TtsStreamChunk.samples: number[]` with a binary-oriented field (choose one):
  - `samples: Float32Array` (preferred JS ergonomics), or
  - `pcm: ArrayBuffer` + sample metadata.
- Keep `instanceId` / `requestId` as internal routing fields only; strip from public chunk callbacks.
- Update TS surface in:
  - `src/tts/types.ts`
  - `src/tts/streamingTypes.ts`
  - `src/tts/streaming.ts`
- Update examples/callers to consume binary chunks without `Array.from(...)`.

**Deliverable:** no `number[]` streaming chunk payload in the public TTS streaming API.

**Detailed sub-plan:** [tts-streaming-perf-subplan-01.md](./tts-streaming-perf-subplan-01.md)

---

### 3.2 Native streaming emit path: binary transport via JSI

- Implement hand-written JSI path for chunk payload construction (same philosophy as batch `getSamples()`).
- Keep TurboModule spec codegen-safe while native impl provides binary object(s).
- Ensure strict ordering and internal request routing remain unchanged; public event surface should remain ID-free.

**Android focus:** avoid JNI crossings per tiny chunk; keep chunk loop local, cross boundary per coalesced binary block.  
**iOS focus:** ObjC++/JSI chunk creation with minimal copies.

**Deliverable:** chunk emit no longer allocates/serializes large `ReadableArray` of doubles.

**Detailed sub-plan:** [tts-streaming-perf-subplan-02.md](./tts-streaming-perf-subplan-02.md)

---

### 3.3 Native chunk coalescing (callback reduction)

- Add configurable chunk aggregation policy:
  - max frames per emit,
  - max time window before flush.
- Tune defaults for long-text throughput while preserving acceptable time-to-first-audio.
- Optionally expose coarse config knob for advanced users.

**Deliverable:** fewer callback invocations and lower JS scheduler pressure for long streams.

**Detailed sub-plan:** [tts-streaming-perf-subplan-03.md](./tts-streaming-perf-subplan-03.md)

---

### 3.4 Stream-to-file first-class flow (no JS PCM)

- Strengthen streaming-to-file route as the preferred export path:
  - native incremental write (WAV first; other formats when supported),
  - JS progress/end/error events only.
- Keep chunk emission optional (`emitChunks`) and off by default for file-only workflows.

**Deliverable:** long-text file export does not route full PCM through JS.

**Detailed sub-plan:** [tts-streaming-perf-subplan-04.md](./tts-streaming-perf-subplan-04.md)

---

### 3.5 Runtime integration and fallback policy

- Define behavior for environments where binary chunk materialization is unavailable:
  - fail fast with explicit error, or
  - temporary legacy mode behind explicit opt-in flag.
- Keep policy explicit and documented; avoid silent regressions to old hot path.

**Deliverable:** deterministic behavior and clear migration story.

**Detailed sub-plan:** [tts-streaming-perf-subplan-05.md](./tts-streaming-perf-subplan-05.md)

---

### 3.6 Documentation and migration (public SDK guidance)

- Update docs:
  - `docs/tts-streaming.md`
  - `docs/migration.md`
- Add migration examples from old `number[]` chunk handlers to binary handlers.
- Keep descriptions high-level and user-oriented:
  - when to use which streaming function,
  - which path is preferred and why (without internal implementation details).

**Deliverable:** users can migrate quickly and choose the right API path with clear preference guidance.

**Detailed sub-plan:** [tts-streaming-perf-subplan-06.md](./tts-streaming-perf-subplan-06.md)

---

## 4. Risks and edge cases

| Risk | Mitigation |
|------|------------|
| Binary contract shape drift across platforms | Shared conformance tests for event payload schema |
| Increased TTFB from chunk coalescing | Time-window cap and tuned defaults |
| JS playback adapters expect `number[]` | Update helper/player APIs and migration snippets |
| Runtime incompatibility in some RN environments | Explicit capability check and clear fallback/error policy |
| Memory spikes from oversized chunk frames | hard max frame cap + flush policy |

---

## 5. Suggested order of sub-plans

1. **Binary chunk API contract** (3.1)
2. **Native binary emit path (JSI)** (3.2)
3. **Chunk coalescing controls** (3.3)
4. **Native stream-to-file primary flow** (3.4)
5. **Fallback policy + runtime checks** (3.5)
6. **Docs and migration guidance** (3.6)

---

## 6. References (codebase)

| Area | Location |
|------|----------|
| Streaming JS API | `src/tts/streaming.ts`, `src/tts/streamingTypes.ts`, `src/tts/types.ts` |
| TurboModule spec | `src/NativeSherpaOnnx.ts` |
| Android streaming | `android/src/main/java/com/sherpaonnx/tts/service/TtsStreamingService.kt`, `android/src/main/java/com/sherpaonnx/tts/service/TtsPcmPlaybackService.kt`, `android/src/main/java/com/sherpaonnx/tts/sink/TtsStreamingWavSink.kt` |
| iOS streaming | `ios/tts/bridge/SherpaOnnx+TTSStream.mm`, `ios/tts/bridge/SherpaOnnx+TTSPcm.mm`, `ios/tts/wav/TtsStreamingWavSink.h` |
| Existing batch sink plan | [tts-generated-audio-native-sink-migration.md](./tts-generated-audio-native-sink-migration.md) |
| PCM player rework (`playback` boolean, reject `writePcmChunk` while native) | [tts-pcm-player-migration.md](./tts-pcm-player-migration.md) |

---

*This document is a planning aid; exact method names and binary payload shape may evolve per sub-plan.*
