# High-level plan: On-the-fly subtitles for TTS streaming (VAD-based)

Internal reference — **not user-facing product documentation.**  
Describes the intended **best-practice architecture** once **VAD** (or equivalent native speech/silence segmentation) is available in the SDK and wired into the app.

**Related docs**

- [Streaming TTS](../tts-streaming.md) — chunk APIs, incremental text, playback
- [Offline TTS / batch timings](../tts-offline.md)
- [Alignment & subtitle modes](../alignment.md) — `proportional`, `estimated`, `accurate` (CTC)
- [VAD](../vad.md) — speech / silence and segment boundaries

---

## Goal

Show **subtitle cues during** `generateSpeechStream` / incremental streaming TTS, then **refine** word or line timings for accuracy — **without** streaming ASR (RNNT) on synthesized audio.

**Ground truth:** The spoken text comes from the **TTS input** (including incremental commits). RNNT/STT is for **microphone / unknown audio**, not for this path.

---

## Guiding principles

| Principle | Rationale |
|-----------|-----------|
| **Text from TTS pipeline, not ASR** | Avoid duplicate compute, mismatched tokens, and merge hell with forced alignment. |
| **Live = cheap timeline** | Use **duration of emitted PCM** and mapping to **known substrings** (plus optional proportional stretch). |
| **Refine = CTC after VAD closure** | When VAD reports **trailing silence** (or agreed end-of-speech), run **wav2vec2 / CTC forced alignment** on the **ring-buffer slice + exact transcript** for that span ([alignment.md](../alignment.md)). |
| **RNNT elsewhere only** | Reserve streaming transducer for **STT** features, not TTS karaoke. |

---

## Architecture

```
Streaming TTS (native chunks + known text spans)
        │
        ▼
┌───────────────────────────────────────────────────┐
│ Rolling audio buffer (PCM, sampleRate, mono)      │
│ + parallel text buffer (committed segments / chars) │
└───────────────────────────────────────────────────┘
        │
        ├─► [Live subtitle layer]
        │      • Map each finished audio chunk → time interval
        │      • Attach the text slice that produced it (incremental / stream contract)
        │      • Optional: proportional within chunk (`alignment` `estimated` ideas)
        │      • Output: draft cues (line or word granularity, may drift slightly)
        │
        ├─► [VAD — control / segmentation]
        │      • Detect speech vs silence on the synthesized stream
        │      • Define soft + hard **segment boundaries** for UI and for refinement triggers
        │      • Trailing silence → close segment → signal refinement layer
        │
        └─► [Refinement layer]  (on VAD segment close)
               • Slice buffer for closed interval + matching **reference** substring
               • `alignTextToAudio` **accurate** mode (or batch path on exported WAV)
               • Replace / anchor draft cues for that window
```

**Subtitle builder:** Merges **draft** (live) and **anchored** (post–CTC) timelines; after refinement, prefer **anchored** times for the covered range to avoid visible jumps (or a defined cross-fade policy).

---

## Implementation phases

### Phase 1 — SDK VAD integration

- [ ] **Native path:** Run VAD on the TTS PCM stream (same clock as chunks / ring buffer).
- [ ] **Bridge:** Expose **speech/silence** state and/or **segment boundary events** to JS (or handle refinement triggers entirely native and surface only subtitle updates).
- [ ] **Contract:** For each streaming event, recover **(samples | duration, sampleRate)** and the **text span** tied to that audio (document chunk ↔ text mapping if not a single API tuple).

### Phase 2 — Triggers and refinement

- [ ] **Primary refinement trigger:** **Trailing silence** (or equivalent “segment closed”) from VAD — slice audio + transcript for that span.
- [ ] **Live cues:** Cumulative timeline from chunk durations + text until refinement lands for the closed segment.
- [ ] **Accurate pass:** `alignTextToAudio` on the closed segment (file path or extended PCM input per [alignment.md](../alignment.md)).
- [ ] **Optional:** On long VAD-defined silence, **flush** incremental text buffer for cleaner subtitle paragraphs in the UI.

### Phase 3 — Polish

- [ ] **Overlap / edges:** Refine overlapping windows if needed; merge CTC boundaries at segment edges (avoid 1-frame glitches).
- [ ] **UX:** Stabilization — limit thrashing of partial words until refinement or min display time.
- [ ] **Performance:** Alignment off the hot path; cap concurrent refinement work.

---

## What not to do (for this feature)

- Do **not** depend on **RNNT/streaming STT** on TTS output as the primary subtitle source.
- Do **not** treat ASR partials as the transcript of record when **TTS input text** is available.
- Do **not** assume **streaming alignment** inside ORT — CTC alignment here is **whole-segment** over a defined audio + text pair ([alignment](../alignment.md)).

---

## Open questions (resolve when implementing)

1. **Incremental text ↔ chunk mapping:** Per-chunk substring vs ordered segments — define ids or byte offsets.
2. **Alignment input:** File path vs float buffer — temp WAV vs native PCM handle.
3. **Refinement latency:** Target delay from VAD “silence” to anchored subtitle replace.
4. **iOS/Android parity:** Same VAD semantics and boundary events on both platforms.

---

## Summary

**Target practice:** known text + **time from audio chunks** for live draft cues; **VAD** defines when a segment **closes**; **CTC forced alignment** on that closed slice refines timings. No ASR on the synthesized waveform for this pipeline.
