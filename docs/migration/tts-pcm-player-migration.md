# Migration plan: Standalone PCM player + TTS integration (streaming playback, batch sink)

High-level plan to introduce a **standalone, TTS-neutral PCM playback** API in the SDK and wire **streaming** and **batch** TTS to it where appropriate. Public names should **not** imply “TTS-only” (e.g. avoid `TtsPcmPlayer` / `writeTtsPcmChunk` on the **documented** surface — exact identifiers in sub-plans).

**Two layers:**

1. **Standalone PCM player** — one **native** implementation (queue + audio output), addressable by a **`playerId`**, with an **explicit input/source contract** (JS vs native feed). Optional **`ttsInstanceId`** only when the player must participate in **TTS engine** semantics (mutex with **`playback: true`** streaming, etc.).
2. **TTS streaming** — **`generateSpeechStream`** gains **`playback: boolean`** and **`emitChunks: boolean`** (defaults **`playback: false`**, **`emitChunks: true`**) — aligned with **`generateSpeechStreamToFile`** for **`emitChunks`**. When **`playback: true`**, synthesis **enqueues audio on the native side** into the bound player (no Kotlin→JS→Kotlin for **playback**).

Use this document to split work into **sub-plans** (see placeholders below) and implement incrementally. **Public API may break**; a single **`docs/migration.md`** entry is sufficient unless you add more detail in **`CHANGELOG.md`**.

**Related plans:** [tts-streaming-performance-migration.md](./tts-streaming-performance-migration.md) (binary chunks, stream-to-file), [tts-generated-audio-native-sink-migration.md](./tts-generated-audio-native-sink-migration.md) / [tts-audio-sink-migration.md](./tts-audio-sink-migration.md) (batch sink, `GeneratedAudio`).

---

## 1. Context and goals

### Problem

- Today, **interactive playback** often follows: native synthesis → chunk event → JS → **`writePcmChunk`** → native player. That duplicates work and (depending on transport) adds avoidable cost.
- **`writePcmChunk`** from JS may still use **`number[]`** or expand **`Float32Array`** to **`number[]`** before the TurboModule — extra overhead on top of the stream path.
- The player is **conceptually generic** (mono float PCM) but **named and routed** like a TTS appendage; **batch TTS**, **streaming**, and **non-TTS PCM** (e.g. mic pipeline) should share one **robust** model instead of inferring behavior from “missing IDs”.

### Goals

#### A) Standalone PCM player (new mental model)

- **Neutral naming** in the **public** SDK surface (sub-plan: package path such as `react-native-sherpa-onnx/pcm` or `.../audio`, type names like **`PcmPlayer`**, method names without **`Tts`** prefix where they are not TTS-specific).
- **Always a `playerId`:** every native player session is keyed by a **generated `playerId`** (or equivalent handle returned from **`createPcmPlayer`** / **`open`**). **Do not** infer “which queue” from optional TTS IDs alone.
- **Explicit source / feed contract** at **creation** (robust variant — **not** “no `ttsInstanceId` ⇒ JS”):
  - **`feed: 'js'`** (names TBD): this session **accepts** PCM via the **JS→native bridge** (e.g. **`writePcmChunk`** / binary follow-up). Use for **external** PCM (mic, tests, manual relay from **`onChunk`** when **`playback: false`**).
  - **`feed: 'native'`**: this session **does not** accept JS **`writePcmChunk`** (reject or no-op with error) — **only** native producers may enqueue (streaming synthesis with **`playback: true`**, future native taps, batch-sink playback, etc.).
- **Optional `ttsInstanceId`:** when set, the native layer can **bind** mutex / reject rules to a **TTS engine instance** (e.g. reject JS **`writePcmChunk`** to the **wrong** session while **`playback: true`** stream is active on that engine). When **unset**, the player is **fully standalone** (typical **`feed: 'js'`** mic/decoded PCM use cases).

#### B) TTS streaming (`generateSpeechStream`)

- **`playback: boolean`** and **`emitChunks: boolean`** (defaults **`playback: false`**, **`emitChunks: true`**):
  - **`playback: true`:** bind stream synthesis to a **`feed: 'native'`** player for this run (or internal equivalent) — native enqueue only.
  - **`emitChunks: true`:** emit chunk events with PCM to JS (binary/`Float32Array` per streaming-perf plan).
  - **`emitChunks: false`:** no chunk PCM to JS for this run; **end/error** events as today unless sub-plan narrows further.
- **Invalid combination:** **`emitChunks: false`** + **`playback: false`** → **no-op** + **`console.warn`** in JS; native should not start a useless synthesis.
- While **`playback: true`** is active for a given **TTS `instanceId`**, any **JS** write to a player session that would **duplicate** that audio must **fail fast** (reject) — typically by enforcing **`feed: 'native'`** for the bound player and rejecting stray **`writePcmChunk`** from JS for that binding (sub-plan).

#### C) Shared implementation

- **One** native enqueue implementation per player session; **stream callback** and **optional batch-sink reader** call the same **`enqueueMonoFloat32`** (or equivalent) as appropriate for **`feed: 'native'`** sessions.

#### D) Optional follow-up

- **Batch TTS:** **`play…FromSink(instanceId, generation)`** or play into a **`feed: 'native'`** session from the batch sink — same sink semantics as **`getTtsSamples`** / **`saveTtsAudioFromSink`**.

### Non-goals (for this high-level track)

- Redesigning **alignment** or **STT** (only note: standalone **`feed: 'js'`** player remains for arbitrary PCM).
- Guaranteeing **backwards compatibility** with old **`startTtsPcmPlayer` / `writeTtsPcmChunk`** names — rework allows renames and new module entry points.

---

## 2. Target architecture (summary)

### 2.1 Standalone player: identity + explicit feed

| Concept | Rule |
|--------|------|
| **`playerId`** | **Always** present — identifies the native player session (queue, lifecycle). |
| **`feed: 'js' \| 'native'`** | Set at **creation** — defines whether **JS bridge writes** are allowed. **Never** infer from “missing `ttsInstanceId`” alone. |
| **`ttsInstanceId` optional** | If set, participate in **TTS engine** coupling (mutex / rejects with streaming **`playback: true`**). If unset, **standalone** use (e.g. mic PCM with **`feed: 'js'`**). |
| **Native producers** | Only for **`feed: 'native'`** sessions — streaming synthesis, batch sink tap, etc. |

### 2.2 TTS streaming: `playback` + `emitChunks`

| Aspect | Today | Target |
|--------|--------|--------|
| Stream → speaker | Often chunk → JS → **`writePcmChunk`** → player | **`playback: true`:** synthesis callback → **enqueue** into a **`feed: 'native'`** player bound to this stream/engine (sub-plan). |
| JS chunk events | Always (coalesced) | **`emitChunks: true`** (default): **`onChunk`** with PCM; **`emitChunks: false`:** no PCM to JS for this run |
| **`playback: false`** | Manual bridge feed typical | With **`emitChunks: true`**: chunks to **`onChunk`**; app may use a **`feed: 'js'`** player + **`writePcmChunk`** manually if desired |
| **`emitChunks: false` + `playback: true`** | — | Native playback only — minimal bridge traffic |
| **`emitChunks: true` + `playback: true`** | — | Native player + JS samples (e.g. waveform) — no **`writePcmChunk`** needed for TTS playback |
| **`emitChunks: false` + `playback: false`** | — | **No-op** + **`console.warn`** |
| **JS `writePcmChunk` vs `playback: true`** | Duplicate risk | **Reject** illegal writes per **`feed`** + binding rules (sub-plan) |
| **Batch `GeneratedAudio` → speaker** | Often save file or `getSamples` then play | **Native** path into **`feed: 'native'`** session or dedicated **`play…FromSink`** (sub-plan) |
| **Parity with stream-to-file** | Separate knobs | **`emitChunks`** shared meaning with **`generateSpeechStreamToFile`**; native session wiring may converge (sub-plan). |

### 2.3 Design rules

1. **`playback`** and **`emitChunks`** are booleans on **`generateSpeechStream`** — defaults **`emitChunks: true`**, **`playback: false`**.
2. **Explicit `feed`** on **player creation** — **`js`** vs **`native`**; do not overload **`ttsInstanceId` absence** as the sole signal for “JS vs native”.
3. **`playerId`** always — standalone and TTS-bound players are **sessions**, not anonymous singletons (unless sub-plan explicitly allows a single global default for migration only).
4. **Android/iOS parity** for **`feed`**, rejects, cancel, **`destroy()`**, and invalid **`emitChunks` + `playback`** combo.
5. **Documentation:** standalone **PCM** chapter + **TTS** chapter cross-link; migration lists **rename** of TurboModule methods if public names change.

---

## 3. Workstreams (sub-plan topics)

### 3.1 API surface (TypeScript + TurboModule contract)

- **Standalone:** public types and entry points (**`createPcmPlayer`**, **`PcmPlayer`**, **`playerId`**, **`feed`**, optional **`ttsInstanceId`**) — exact names in sub-plan.
- **TurboModule:** introduce or rename methods from **`startTtsPcmPlayer` / `writeTtsPcmChunk` / `stopTtsPcmPlayer`** to **neutral** names where they are generic; keep internal compatibility layer if needed during migration.
- **Streaming:** **`playback`**, **`emitChunks`**, defaults, no-op combo (**`emitChunks: false` + `playback: false`**).
- **Reject matrix:** document when **`writePcmChunk`** (JS) is rejected (`feed: 'native'`, active **`playback: true`** stream, etc.).

**Deliverable:** TS surface + spec sketch; **`migration.md`** entries for renames and **`feed`** semantics.

**Detailed sub-plan:** [tts-pcm-player-subplan-01.md](./tts-pcm-player-subplan-01.md) *(create when ready)*

---

### 3.2 Android: player registry + `feed` + single enqueue

- Refactor **`TtsPcmPlaybackService`** (rename in sub-plan) to a **player registry** keyed by **`playerId`** with **`feed: js|native`** and optional **`ttsInstanceId`**.
- **`enqueueMonoFloat32`** shared by: JS bridge (only if **`feed: 'js'`**), streaming callback when **`playback: true`**, optional batch-sink tap.
- **`emitChunks`** / **`playback`** in **`TtsStreamingService`** as in current plan; bind stream to **`feed: 'native'`** player for **`playback: true`**.

**Deliverable:** native behavior matches **`feed`**, streaming integration, rejects.

**Detailed sub-plan:** [tts-pcm-player-subplan-02.md](./tts-pcm-player-subplan-02.md) *(create when ready)*

---

### 3.3 iOS: same semantics

- Mirror Android: **player registry**, **`feed`**, **`playerId`**, optional engine binding.
- Stream path: **`playback: true`** → native enqueue; **`emitChunks`** gates chunk payload.

**Deliverable:** parity with Android.

**Detailed sub-plan:** [tts-pcm-player-subplan-03.md](./tts-pcm-player-subplan-03.md) *(create when ready)*

---

### 3.4 TTS batch: play from native sink (optional in same rework)

- **`play…FromSink(instanceId, generation)`** or enqueue into a **`feed: 'native'`** player — stale generation errors aligned with **`getTtsSamples`**.

**Deliverable:** hear last **`generateSpeech`** without **`saveAudio`** / without **`getSamples()`** for playback-only flows.

**Detailed sub-plan:** [tts-pcm-player-subplan-04.md](./tts-pcm-player-subplan-04.md) *(create when ready)*

---

### 3.5 Documentation and migration

- **`docs/tts-streaming.md`**, new or updated **`docs/pcm-player.md`** (or equivalent): standalone player (**`playerId`**, **`feed`**, **`ttsInstanceId`**), streaming matrix (**`playback`**, **`emitChunks`**), rejects, no-op warning.
- **`docs/migration.md`:** renames, **`feed`** model, defaults.
- **`CHANGELOG.md`:** breaking/feature bullets.

**Detailed sub-plan:** [tts-pcm-player-subplan-05.md](./tts-pcm-player-subplan-05.md) *(create when ready)*

---

### 3.6 Example app and tests (optional)

- Standalone **`feed: 'js'`** player (e.g. synthetic sine / mic path if available).
- Streaming **`playback: true` + `emitChunks: true`** vs **`emitChunks: false` + `playback: true`**.
- Assert rejects: **`writePcmChunk`** to **`feed: 'native'`**; duplicate feed during **`playback: true`**.

**Detailed sub-plan:** [tts-pcm-player-subplan-06.md](./tts-pcm-player-subplan-06.md) *(optional)*

---

## 4. Suggested order of sub-plans

1. **3.1** API surface (standalone + streaming + TurboModule rename sketch)
2. **3.2** Android registry + **`feed`** + stream wiring
3. **3.3** iOS parity
4. **3.4** Optional batch sink playback
5. **3.5** Docs + migration
6. **3.6** Tests/example (optional)

---

## 5. Risks and edge cases

| Risk | Mitigation |
|------|------------|
| Confusion **`feed: 'js'`** vs **`feed: 'native'`** | Table in docs; errors mention **`feed`** |
| **`emitChunks: false` + `playback: false`** | No-op + **`console.warn`** |
| **`destroy()`** / cancel | Clear lifecycle per **`playerId`** and per TTS stream |
| Two TTS engines | **`ttsInstanceId`** scoping for mutex rules |
| Rename churn | **`migration.md`** one-stop |

---

## 6. References (codebase)

| Area | Location |
|------|----------|
| Streaming JS | `src/tts/streaming.ts`, `src/tts/types.ts` |
| TurboModule | `src/NativeSherpaOnnx.ts` |
| Android PCM (current) | `android/.../tts/service/TtsPcmPlaybackService.kt` |
| Android streaming | `android/.../tts/service/TtsStreamingService.kt` |
| iOS streaming / PCM | `ios/tts/bridge/SherpaOnnx+TTSStream.mm`, related PCM bridge files |

**Future (sub-plan):** standalone TS module path (e.g. `src/pcm/` or `src/audio/`) — to be added when exports are fixed.

---

*This document is a planning aid; exact identifiers (`feed` string literals vs enum, method names on TurboModule) are fixed in sub-plans **3.1–3.3**.*
