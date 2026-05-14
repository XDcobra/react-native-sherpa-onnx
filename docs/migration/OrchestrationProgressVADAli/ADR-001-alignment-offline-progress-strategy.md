# ADR-001: Alignment offline — progress strategy (`OrchestrationProgress`)

| Field | Value |
| --- | --- |
| Status | **Accepted** |
| Date | 2026-05-13 |
| Context | Public SDK (pre-release); consistency with STT/TTS/Enhancement batch **`onProgress`** story. |

## Context

Alignment (`runAlignTextToAudio` / TS drivers + native `alignOfflineTextToAudio`) is **offline-only** and **does not** use `src/pipeline/offlineOrchestrator.ts` today. We still want **one predictable progress contract** for app developers and internal UI.

Prior options (see [README](./README.md) §2):

- **A** — Refactor alignment to run **inside** the generic offline orchestrator loop.
- **B** — Instrument drivers only; ad-hoc progress payloads.
- **C** — **Hybrid:** instrument drivers **but** reuse the **same public type and field semantics** as `OrchestrationProgress`, with a **small shared emitter** (no full orchestrator ownership of alignment control flow).

## Decision

We adopt **Strategy C (hybrid instrumentation)**.

### Rationale (public SDK quality bar)

1. **Domain fit:** Alignment modes (proportional, estimated, VAD-anchored, accurate + ASR-mediated / chunked CTC, …) do not share one natural **“segment × same consumer”** shape. Forcing **A** risks contorted adapters and long-term fragility.
2. **API consistency without lying:** Callers get **`OrchestrationProgress`** (or an explicitly documented **type alias** re-exporting it) so UI code can be reused; implementation stays in alignment drivers where the real milestones live.
3. **Pre-release clean cut:** We can introduce **`onProgress?: (progress: OrchestrationProgress) => void`** on `AlignTextToAudioOptions` **once**, with per-mode semantics documented in [phase-0-alignment-progress-semantics.md](./phase-0-alignment-progress-semantics.md), without legacy baggage.

## Public API (normative)

- **Field name:** `onProgress` on **`AlignTextToAudioOptions`** (exact placement follows TypeScript export; mirror optional pattern used by `SttTranscribeOptions` / `TtsSynthesisOptions`).
- **Payload type:** **`OrchestrationProgress`** from `src/pipeline/offlineOrchestrator.ts` (re-export from `alignment` or `types` as needed for ergonomics).
- **When it fires:** **Start of progress step `i`**, before the heavy work of that step begins — **same convention** as `reportProgress` in `offlineOrchestrator.ts`, so documentation can cross-reference one rule.
- **Non-goals (must be documented):**
  - Not sample-accurate or waveform-level.
  - Not a substitute for alignment **warnings** / partial coverage flags on the result object.
  - Does not imply STT-style **retry** / `errorRecovery` unless we explicitly add that later (out of scope for ADR-001).

## Implementation sketch (non-binding)

- Add a tiny internal helper (e.g. `alignment/progress.ts`) that computes `{ currentSegment, totalSegments, fraction, currentSegmentDurationMs, elapsedMs }` from a session start timestamp and step metadata — **mirroring** `reportProgress` math to avoid drift.
- Call the helper from **`runAccurateChunkedForcedCtc`**, **`runAccurateAsrMediated`**, then extend to native-backed modes per [phase-0](./phase-0-alignment-progress-semantics.md).
- **Tests:** each mode that emits more than one event gets at least one unit test asserting ordering and bounds (`0 <= currentSegment < totalSegments` when `totalSegments > 0`).

## Consequences

- **Positive:** Clear separation — progress is **observability**, alignment algorithms stay authoritative.
- **Negative:** `totalSegments` may be **mode-specific** or **estimated**; callers must read the semantics table (Phase 0). We avoid changing the **`OrchestrationProgress`** type shape where possible; if a mode cannot know totals upfront, Phase 0 defines the contract (e.g. single-shot `totalSegments === 1`).

## Status of alternatives

| Strategy | Outcome |
| --- | --- |
| **A** | **Rejected** for initial implementation; may be revisited only if a future mode is provably identical to the generic orchestrator loop without adapters. |
| **B** (raw ad-hoc) | **Subsumed by C** — we still instrument drivers, but **not** with ad-hoc bespoke progress objects. |

## References

- [README — Alignment section](./README.md)
- [Phase 0 — per-mode semantics](./phase-0-alignment-progress-semantics.md)
- [`offlineOrchestrator.ts` — `OrchestrationProgress` / `reportProgress`](../../../src/pipeline/offlineOrchestrator.ts)
