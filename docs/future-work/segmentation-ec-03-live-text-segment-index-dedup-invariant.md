# Segmentation / live text: EC-03 — segmentIndex dedup invariant (deferred)

**Status:** Deferred — not scheduled for the current Sub-06-02 / Phase 7 event-parity pass.  
**Origin:** [sub-06-02-event-contract-parity-tracking.md](../migration/segmentationEngine/sub-06-02-event-contract-parity-tracking.md) **EC-03**.

---

## 1. Problem

In `src/textbuffer/index.ts`, `dispatchLiveTextSegmentEvent` **drops** native `pipelineLiveTextSegmentAppended` deliveries when `segment.segmentIndex <= lastSegmentIndex` (monotonic deduplication keyed by buffer).

If any native or worker path ever emits **non‑strictly‑monotonic** `segmentIndex` values (replay, reorder, bug), **onSegment callbacks fire fewer times than expected** with no explicit error.

---

## 2. Intended resolution (when picked up)

1. **Document or enforce an invariant:** For a given live text buffer, `segmentIndex` in `pipelineLiveTextSegmentAppended` is **strictly increasing** per commit order (including STT / worker paths). Add the invariant to `sub-03-buffer-integration.md` or live-text buffer public docs once verified.
2. **If the invariant is violated in the wild:** Fix the **producer** (native / worker), not the TS deduper, unless analysis shows the dedup itself is wrong.
3. **Verification:** Short audit of all `pipelineLiveTextSegmentAppended` emitters (Android / iOS / workers) and at least one test per critical path: “monotonic `segmentIndex`”.

**Code reference:** `src/textbuffer/index.ts` — `dispatchLiveTextSegmentEvent`, `textLastSegmentIndexByBuffer`.

---

## 3. Follow-up checklist (when un-deferred)

- [ ] Audit: all `pipelineLiveTextSegmentAppended` emitters (Android / iOS / STT worker).
- [ ] Add invariant to migration or user-facing buffer docs after audit.
- [ ] Add tests: monotonic `segmentIndex` per path (or explicit contract test on TS listener behaviour given fixture indices).
- [ ] Update EC-03 row in `sub-06-02-event-contract-parity-tracking.md` from `deferred` to `accepted` / `resolved` as appropriate.
