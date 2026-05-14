# Implementation plan — VAD offline Phase 3: Edge cases & hardening

**Goal:** Close **semantic**, **reliability**, and **documentation** gaps for segmented offline VAD + progress after [Phase 2](./impl-vad-offline-phase-2-progress.md).

---

## 1. Empty & degenerate audio

| Scenario | Expected behaviour (define in ADR if not already) |
| --- | --- |
| Zero-length offline buffer | Deterministic result: `segmentCount === 0` or native-equivalent; **no** unbounded native hang. |
| Silence-only (segmentation yields zero speech segments) | Document: skip all `runVadOffline` **or** one full-buffer fallback — **must** match Phase 1 choice. |
| Single speech segment covering full file | `totalSegments === 1`; one `onProgress`; one native call — equivalent to full pass **if** slice equals whole (verify sample-accurate boundaries). |

---

## 2. Retry / error recovery

- **STT parity:** `SttTranscribeOptions` exposes `errorRecovery`, `maxRetriesPerSegment`, … **VAD offline v1:** explicitly **no retry** unless ADR adds fields — document “fail fast per segment”.
- **Partial results:** if segment `k` fails, options: abort entire operation (throw) **vs** skip segment and continue — **pick one**; orchestrator supports strategies; VAD can start with **abort** only for simplicity.

---

## 3. Boundary & merge correctness

- **Overlap / policy `hangoverMs`:** compare segmented VAD output boundaries to single-pass reference on golden files (tolerance documented).
- **Sample rate:** ensure each temp slice carries correct `sampleRate` for native.

---

## 4. Performance validation

- Benchmark long file: single `runVadOffline` vs N segmented calls — record ratio; if >2× slower, document tuning knobs (`minSegmentMs`, policy).

---

## 5. Security / robustness

- **Callback throwing:** align with orchestrator (document caller responsibility); optional guard matching STT.
- **Extremely large `N` segments:** ensure progress callback not O(N) allocation per call.

---

## 6. Documentation checklist

- [x] **CHANGELOG** entry for VAD offline segmentation + `onProgress`.
- [x] **Migration note:** apps relying on “VAD always whole file” learn that **`segmentation.mode`** controls behaviour.
- [x] **FAQ:** “Why do my VAD segments differ when I enable auto segmentation?” — link README risk §3.

---

## 7. Exit criteria

- [x] Golden / snapshot-style unit coverage for **silence**, **single-speech**, **multi-speech** scenarios.
- [x] ADR-002 updated with **final** edge-case decisions.
- [ ] Product sign-off on semantic change risk ([README](./README.md) §3 risks).

---

## 8. Optional follow-ups (post Phase 3)

- **`errorRecovery` / `retryExhaustedFallback`** parity with STT.
- **Manual segmentation** for VAD offline.
- **Central progress matrix** doc page.
