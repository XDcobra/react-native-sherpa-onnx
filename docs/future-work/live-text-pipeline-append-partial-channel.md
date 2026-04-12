# Live text pipeline: append channel for partials (future work)

**Status:** Design note — not implemented.  
**Scope:** Native / pipeline **append listeners** on `LiveTextBuffer` (and any mirror API on the JS facade). **Does not** change the default contract until explicitly opted in.

---

## 1. Current contract (as decided for streaming STT / live text pipeline)

**Append notifications** (the mechanism that wakes **downstream native pipeline workers** — e.g. online alignment, future live TTS — so they can consume new stable text) fire **only** when:

- a new **committed segment** is produced (`commitSegment`), and/or  
- the buffer is **finalized** (`finalize_`),

depending on the exact pipeline spec for your STT integration.

**`writePartial`** updates the rolling hypothesis for **UI / inspection** (e.g. JS `onPartial` / `pipelineLiveTextPartial` when enabled and throttled). It **does not** trigger the same **append** / segment listener path used for **pipeline chaining** under this default.

**Rationale:** partials are unstable; driving heavy downstream work off every partial would cause churn, races, and wasted work. **Segment default** keeps pipelines predictable and performant.

---

## 2. Future extension: second channel (partials)

We anticipate use cases that need **native** reactions to **partial** updates as well (e.g. speculative live TTS, advanced analytics, custom co-processors), without overloading the **segment** channel.

**Plan:**

1. Introduce an **optional second listener tier** (or a **single listener with discriminated `kind`**: `'segment' | 'partial'`) so consumers can subscribe to:
   - **segment** events only (default, current behaviour), or  
   - **segment + partial**, or  
   - **partial only** (unusual; only if ever needed).

2. **Configuration at engine / buffer creation** (exact surface TBD), for example:

   ```text
   pipelineAppendTrigger: 'segment'   // default — current behaviour
   pipelineAppendTrigger: 'partial'   // future: wake workers on partial updates (throttled)
   pipelineAppendTrigger: 'both'      // future: segment + partial (each throttled appropriately)
   ```

   Naming is illustrative; final names should align with `CreateLiveTextBufferOptions` / streaming STT factory options.

3. **Throttling** for partial-driven append signals is **mandatory** if this channel exists (same idea as `partialEventMinIntervalMs` for JS partial emission): avoid bridge or internal storms when the recogniser refreshes hypotheses tens of times per second.

4. **Backward compatibility:** default remains **`segment`** only; existing pipelines require **no** code change until they opt into partial-driven wakes.

---

## 3. Relationship to JS `onPartial`

- **JS `onPartial`** remains the primary path for **UI** real-time text.  
- **Native append / partial channel** is for **in-process pipeline** consumers that must react on the native side with minimal or no JS involvement.  
- The two are **orthogonal**: you can keep JS partials enabled while pipeline append stays **segment-only**, or later enable **partial** pipeline wakes without changing UI behaviour.

---

## 4. Related documents

- [Online STT live text pipeline spec](../migration/online/online-stt-live-text-pipeline-spec.md) — segment log, `commitSegment` vs `writePartial`, listener defaults (e.g. Q3 / Q7).  
- [Pipeline text buffers (`textbuffer`)](../textbuffer.md) — public `textbuffer` API.  
- [Online enhancement live pipeline spec](../migration/online/online-enhancement-live-pipeline-spec.md) — parallel native workers on live audio (analogy for staged wakes).

---

## 5. Acceptance criteria (when implemented)

- Default: append / pipeline wake **only** on **segment** (+ finalize as specified).  
- Opt-in: flag or enum selects **partial** or **both**; partial path is **throttled** and documented.  
- No silent change for existing apps: **default = segment**.
