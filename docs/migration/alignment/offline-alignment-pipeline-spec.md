# Offline alignment migration: TextBuffer + AudioBuffer pipeline

**Status:** Specification and breaking cleanup (TTS-sink alignment removed from public API).  
**Scope:** **Offline** alignment only: transcript + recorded or synthesized **mono** audio, all three modes (`proportional`, `estimated`, `accurate`). **Online / streaming alignment** (live STT partials, live mic) is **out of scope** here and will use different native entry points later.

---

## 1. Relationship to STT and TTS pipelines

| Feature | Primary inputs | Primary outputs |
| --- | --- | --- |
| **Offline STT** | `OfflineAudioBuffer` | `OfflineTextBuffer` |
| **Offline TTS** | `OfflineTextBuffer` | `OfflineAudioBuffer` |
| **Offline alignment** | `OfflineTextBuffer` + `OfflineAudioBuffer` | Subtitle timeline (today: `AlignTextToAudioResult` in JS; target: optional `OfflineTextBuffer` or stable result type — see §5.4) |

Alignment is **read-only** on both buffers: it must not mutate transcript or PCM except through future explicitly scoped “write timings to buffer” APIs if added later.

---

## 2. Current state (as-is, pre–full pipeline)

### 2.1 Public JS (`src/alignment/`)

- **`alignTextToAudio(text, audio, options)`**  
  - `text`: **`string`**  
  - `audio`: **`string`** (file path) or **`{ samples: Float32Array; sampleRate }`**  
  - Delegates to **`alignTextToAudioFromPath`** / **`alignTextToAudioFromPcm`** on the TurboModule.

- **`alignTextToTtsSink(text, generatedAudio, options)`** (**removed**)  
  - Coupled **`GeneratedAudio`** (TTS batch sink: `generation`, `_instanceId`).  
  - Not a pipeline buffer; duplicated lifetime rules with `OfflineAudioBuffer`.

- **`assertAlignmentGranularityForMode(mode, granularity)`** — throws if `character` is used without **accurate** / **aligned** mode (see §6).

- **`detectAlignmentModel`** — unchanged role (folder scan, `paths.model` for wav2vec2).

### 2.2 Native (Android / iOS)

- Path / PCM alignment entry points exist.  
- **TTS sink snapshot** path existed for `alignTextToTtsSink`; removed in favour of **pipeline audio buffers** (TTS output should land in `OfflineAudioBuffer` first, then alignment reads that buffer).

### 2.3 Documentation (`docs/alignment.md`)

- Mixed **file / Float32Array** quick starts with **`alignTextToTtsSink`** section.  
- To be replaced by **buffer-first** examples and a link to this spec.

---

## 3. Goals

1. **Single mental model**  
   Offline alignment consumes **`OfflineTextBuffer`** + **`OfflineAudioBuffer`** (branded handles / `*Ref` / `*IdSource` unions — same ergonomics as STT/TTS).

2. **Strong typing**  
   - Entry API accepts **`OfflineTextBufferIdSource`** and **`OfflineAudioBufferIdSource`** (exact TypeScript names aligned with `textbuffer` / `audiobuffer` modules).  
   - **Reject at type level** passing a **`LiveAudioBufferRef`** / **`LiveTextBufferRef`** where offline-only alignment is requested (overload or distinct function name, e.g. `alignOfflineTextToAudio`).

3. **Remove non–alignment integration**  
   - **`alignTextToTtsSink`** removed entirely (**no** deprecation). TTS output alignment uses **`OfflineAudioBuffer`** produced by **`synthesize`** (or file-backed buffer from save-then-load), not sink handles.

4. **Modes and granularity (required)**  

   | Mode | Granularity |
   | --- | --- |
   | `proportional` | `sentence` \| `word` |
   | `estimated` | `sentence` \| `word` |
   | `accurate` | `sentence` \| `word` \| `character` |

5. **iOS parity**  
   Every Kotlin registry / TurboModule / JNI change has a matching iOS implementation.

---

## 4. Non-goals (this document)

- **Online** alignment API surface.  
- Writing subtitle JSON **into** a text buffer (optional follow-up).  
- UI / player integration (see **`pcm-player.md`**, **`audiobuffer.md`** / **`audiobuffer-offline.md`**).

---

## 5. Target API (concrete proposal)

### 5.1 Primary function (name TBD)

```ts
// Conceptual — final export name may be `alignOfflineTextToAudio` or `alignTextToAudio` (breaking reshape).

function alignTextToAudio(
  textIn: OfflineTextBufferIdSource,
  audioIn: OfflineAudioBufferIdSource,
  options: AlignTextToAudioOptions
): Promise<AlignTextToAudioResult>;
```

- Native resolves buffer ids, reads **text** via text-registry slices (or zero-copy internal pointer range) and **audio** via audio-registry (file-backed or RAM), then runs existing **AlignProportional** / **AlignEstimated** / **AlignAccurate**\* C++ paths.  
- **Estimated** mode still requires **`segmentSampleCounts`** (+ sample rate) in `options`; source may be TTS native timeline, STT, or manual — **not** alignment’s job to obtain counts from TTS.

\*Accurate: wav2vec2 path from PCM or decoded file; unchanged scientifically.

### 5.2 Convenience (optional, later)

- **`alignTextToAudioFromPath(text: string | OfflineTextBufferIdSource, wavPath: string, options)`** — only if product still wants path shortcut without creating `OfflineAudioBuffer` first.

### 5.3 TurboModule

- Prefer **one** method: e.g. **`alignOfflineTextToAudio(textBufferId, audioBufferId, mode, granularity, optionsMap)`** returning `{ subtitles, timingMode }`.  
- Remove **`alignTextToTtsSink`** from the spec and from native implementations.

### 5.4 Result payload

- **Phase 1:** Keep **`AlignTextToAudioResult`** (`subtitles`, `timingMode`) as today.  
- **Phase 2 (optional):** Write structured timings into an **`OfflineTextBuffer`** (new native capability) or return a small handle to a native-only “timing blob” — separate spec if needed.

---

## 6. Character granularity for proportional and estimated

**Today (JS guard):** `assertAlignmentGranularityForMode` forbids `character` unless mode is **aligned** (accurate CTC).

**Question:** Can `proportional` / `estimated` support **`character`** as well?

- **Proportional:** timing is derived from **text weight** + total duration, then split by granularity. **Character**-level implies splitting the transcript into characters and distributing duration; this is **possible in principle** but may produce **poor UX** (very short per-grapheme intervals, punctuation edge cases, combining characters). **Native** `AlignProportional` must explicitly accept `character` and define Unicode segmentation rules.  
- **Estimated:** requires **`segmentSampleCounts`** aligned to the same segmentation as `granularity`. **Character** + chunk counts only makes sense if the timeline is **per character** (unusual for TTS chunk APIs which are usually word/sentence sized). **Feasible** only if callers supply counts with length matching character segments.

**Recommendation:**  
1. **Short term:** keep **`sentence` \| `word`** for proportional / estimated unless native sherpa-onnx alignment API is verified to support `character` for those modes.  
2. **If extended:** relax **`assertAlignmentGranularityForMode`** and TS discriminated unions together with **native** validation and tests.  
3. Document **accurate** as the **supported** path for **character**-level forced alignment (CTC).

---

## 7. Migration plan (phased)

| Phase | Work |
| --- | --- |
| **P0** | Remove **`alignTextToTtsSink`** from JS, TurboModule spec, Android (`SherpaOnnxModule`, `SherpaOnnxAlignmentHelper`), and iOS (`SherpaOnnx+Alignment`). Simplify `SherpaOnnxAlignmentHelper` constructor (drop TTS sink snapshot lambda) if unused elsewhere. |
| **P1** | Native: **`alignOfflineTextToAudio`** (names illustrative) reading text + audio **pipeline** registry entries; strict buffer-kind checks. |
| **P2** | TypeScript: new **`alignTextToAudio`** signatures (or renamed export) with **`OfflineTextBufferIdSource`** / **`OfflineAudioBufferIdSource`**; remove **`string` + path** overloads if breaking OK, or keep thin wrappers. |
| **P3** | **`docs/alignment.md`**: buffer-only quick starts; link STT/TTS docs for producing buffers. |
| **P4** | Example app / screens: migrate off path-only or `alignTextToTtsSink` patterns. |
| **P5** | Optional: character support for proportional / estimated after native proof + tests. |

**Codegen:** After editing **`src/NativeSherpaOnnx.ts`**, run React Native **codegen** (Android Gradle / iOS pod) so **`NativeSherpaOnnxSpec`** drops removed methods.

---

## 8. Acceptance criteria (draft)

- No public **`alignTextToTtsSink`** symbol in **`react-native-sherpa-onnx/alignment`**.  
- Offline alignment entry uses **only** pipeline buffer ids (or refs) for **text** and **audio** inputs in the final API shape.  
- All three modes and required granularities work on **Android and iOS** with the same TurboModule contract.  
- **`docs/alignment.md`** describes the buffer pipeline and links here.

---

## 9. Related documents

- [Alignment user doc](../../alignment.md)  
- [TextBuffer pipeline spec](../textbuffer/textbuffer-pipeline-spec.md)  
- [Offline TTS buffer spec](../tts/tts-offline-buffer-pipeline-spec.md)  
- [Offline STT](../../stt-offline.md)  
- [`audiobuffer` (overview)](../../audiobuffer.md), [`audiobuffer-offline`](../../audiobuffer-offline.md), [`textbuffer`](../../textbuffer.md)
