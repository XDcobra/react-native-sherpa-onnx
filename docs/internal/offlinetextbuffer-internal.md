# OfflineTextBuffer — Internal Architecture

**Scope:** Internal implementation details of `offlineTextBuffer` (the offline/immutable text buffer).  
**Audience:** SDK developers planning engine integrations, text pipeline flows, and post-processing strategies.  
**Native entry types:** `OfflineTextEntry` (Android/Kotlin), `PaOfflineTextEntry` (iOS/C++).

---

## 1. Overview

An `OfflineTextBuffer` is an **immutable, fully populated text container**. Once created and populated, its content never changes. It represents a complete text result — typically an STT transcription output, an imported text for TTS input, or a snapshot from a live text buffer.

Key characteristics:
- **Immutable after population:** No append, no partial writes.
- **Rich metadata:** Beyond the raw text string, it can hold tokens, timestamps, durations, language, emotion, and event metadata.
- **Slice-based reads:** Large payloads are accessed via slice APIs to avoid copying everything through the JS bridge at once.

---

## 2. Core Data Structure

```
┌─────────────────────────────────────────────────────────────┐
│              OfflineTextEntry                                 │
│                                                              │
│  bufferId: string (txt_off_<uuid>)                           │
│  kind: 'offlineTextBuffer'                                   │
│  state: 'immutable'                                          │
│                                                              │
│  ─── Text Payload ───                                        │
│  text: string (full hypothesis)                              │
│  utf16Length: number (text.length in JS semantics)            │
│                                                              │
│  ─── Token-Level Metadata (optional) ───                     │
│  tokens: string[] (per-token strings)                        │
│  tokenCount: number                                          │
│  timestamps: number[] (per-token start times)                │
│  timestampCount: number                                      │
│  durations: number[] (per-token durations)                   │
│  durationCount: number                                       │
│                                                              │
│  ─── Scalar Metadata (optional) ───                          │
│  lang: string (e.g. "en", "de")                              │
│  emotion: string (model-dependent)                           │
│  event: string (model-dependent)                             │
│  hasLang / hasEmotion / hasEvent: boolean                    │
│                                                              │
│  ─── Storage ───                                             │
│  All data is held in native heap memory.                     │
│  No file-backed/mmap variant (text is small).                │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Storage: Always In-Memory

Unlike `OfflineAudioBuffer` (which has InMemory and FileBacked variants), `OfflineTextBuffer` is **always in-memory**. Rationale:

- Text payloads are orders of magnitude smaller than audio PCM. A 1-hour transcription is typically < 100 KB of text.
- Token/timestamp arrays for a 1-hour transcription are typically < 1 MB.
- The overhead of file-backed storage (temp file creation, mmap setup) is not justified.

---

## 4. Creation Paths

### 4.1 `createEmptyOfflineTextBuffer()`

Creates an **unpopulated** buffer that serves as an output target:
- Used by offline STT: `stt.transcribe(audioIn, textOut)` fills `textOut` with the transcription result.
- After `transcribe()`, the buffer contains the full hypothesis, tokens, timestamps, etc.
- The buffer is populated **exactly once** by the native STT engine.

```
createEmptyOfflineTextBuffer()
    → native allocates OfflineTextEntry (empty)
    → stt.transcribe(audio, textOut) fills:
        text, tokens, timestamps, durations, lang, emotion, event
    → buffer is now immutable
```

### 4.2 `createOfflineTextBufferFromText(text, options?)`

Creates a **pre-populated** buffer from a string:
- Used as TTS input: `tts.synthesize(textIn, audioOut)`.
- Immediately immutable after creation.
- Optional metadata: `lang`, `emotion`, `event`.

```
createOfflineTextBufferFromText("Hello world", { lang: "en" })
    → native allocates OfflineTextEntry
    → text = "Hello world", utf16Length = 11
    → lang = "en", hasLang = true
    → buffer is immutable
```

### 4.3 `createOfflineTextBufferFromLive(liveBuffer, mode)`

Creates an immutable snapshot from a live text buffer:

| Mode | Behavior |
|---|---|
| `'fullIfSpooled'` | Replays the live buffer's spool (checkpoint + journal) → reconstructs full text → populates offline buffer. Strict: rejects if spool unavailable/corrupted. |
| `'windowSnapshot'` | Snapshots the current in-memory window of the live buffer → populates offline buffer. Only captures what's in the live window at that moment. |

---

## 5. Data Access (Slice APIs)

All reads use **slice-based APIs** to avoid crossing the JS bridge with large payloads:

### Text Slices
```ts
getOfflineTextBufferTextSlice(buffer, startUtf16, maxUtf16): Promise<string>
```
- Reads a substring from `startUtf16` to `startUtf16 + maxUtf16`.
- UTF-16 indices match JavaScript `string.substring()` semantics.
- To read the full text: `getOfflineTextBufferTextSlice(buffer, 0, info.utf16Length)`.

### Token Slices
```ts
getOfflineTextBufferTokensSlice(buffer, start, maxCount): Promise<string[]>
```
- Reads `maxCount` tokens starting from index `start`.
- Returns an array of token strings.

### Timestamp Slices
```ts
getOfflineTextBufferTimestampsSlice(buffer, start, maxCount): Promise<number[]>
```
- Reads `maxCount` timestamps (per-token start times).
- Values are in seconds (float).

### Duration Slices
```ts
getOfflineTextBufferDurationsSlice(buffer, start, maxCount): Promise<number[]>
```
- Reads `maxCount` durations (per-token durations).
- Values are in seconds (float).

### Scalar Metadata
```ts
getOfflineTextBufferLang(buffer): Promise<string>
getOfflineTextBufferEmotion(buffer): Promise<string>
getOfflineTextBufferEvent(buffer): Promise<string>
```
- Direct reads, no slicing needed (single string values).

### Constants
```
TEXT_DEFAULT_SLICE_COUNT = 1024    // default maxCount for slice APIs
TEXT_MAX_SLICE_COUNT     = 16384   // safety limit to prevent bridge overload
```

---

## 6. Populate-Once Semantics

The buffer enforces **single-write semantics**:

1. After creation (`createEmpty`), the buffer is in an "awaiting population" state.
2. A native producer (STT engine) writes the result **once**.
3. After population, any further write attempt is rejected with `TEXT_ALREADY_POPULATED`.
4. The buffer transitions to `state: 'immutable'` permanently.

For `createOfflineTextBufferFromText` and `createOfflineTextBufferFromLive`, the buffer is already populated at creation time — no separate population step.

---

## 7. Memory & Performance Architecture

### Memory Footprint

| Component | Typical Size | Notes |
|---|---|---|
| Text string | < 100 KB (1 hour) | UTF-8 stored natively, UTF-16 length tracked |
| Token array | < 500 KB (1 hour) | One string per token |
| Timestamp array | < 200 KB (1 hour) | One float per token |
| Duration array | < 200 KB (1 hour) | One float per token |
| Scalar metadata | < 1 KB | lang, emotion, event strings |
| **Total** | **< 1 MB typical** | Well within mobile memory budget |

### Bridge Efficiency

Slice APIs prevent sending the full text/tokens through the React Native bridge in one call:
- `getOfflineTextBufferTextSlice(buf, 0, 1024)` sends at most 1024 UTF-16 characters.
- `getOfflineTextBufferTokensSlice(buf, 0, 128)` sends at most 128 token strings.
- The caller can paginate through large results.

---

## 8. Thread Safety

- **Immutable after population:** No concurrent write concerns.
- **Registry access** protected by lock for buffer lookup.
- **Slice reads** are thread-safe (read-only data).
- **Population** (by STT engine) happens on a native worker thread; the buffer is "published" to the registry atomically after population completes.

---

## 9. Key Design Decisions

| Decision | Rationale |
|---|---|
| Always in-memory (no mmap) | Text is small. File-backed storage adds complexity without benefit. |
| Populate-once semantics | Matches offline engine output: STT runs once, produces one result. Prevents accidental double-write. |
| Slice-based reads (not full payload) | Avoids bridge overload for very long transcriptions. Enables progressive UI loading. |
| UTF-16 indices | Matches JavaScript string semantics. Avoids UTF-8/UTF-16 index conversion at the bridge. |
| Rich metadata (tokens, timestamps, durations) | Offline STT models (Whisper, SenseVoice, etc.) produce this metadata. Storing it in the buffer avoids separate return channels. |
| Separate lang/emotion/event fields | Some models (SenseVoice) produce language detection, emotion, and audio event classification alongside transcription. |

---

## 10. Implications for Fake-Live / Pipeline Flows

### As STT Output
In an offline pipeline: `OfflineAudioBuffer → STT → OfflineTextBuffer`. The text buffer receives the full transcription result at once. No streaming, no partial updates.

### As TTS Input
In an offline pipeline: `OfflineTextBuffer → TTS → OfflineAudioBuffer`. The TTS engine reads the full text from the buffer and produces audio.

### In a Fake-Live Engine
For per-segment offline STT:
1. Each segment produces its own `OfflineTextBuffer`.
2. The orchestrator reads the text from each buffer.
3. Appends the text as a segment to a `LiveTextBuffer` (for unified output).
4. Releases the per-segment `OfflineTextBuffer`.

This pattern keeps each offline buffer small and short-lived, with the `LiveTextBuffer` providing the unified streaming-like output.
