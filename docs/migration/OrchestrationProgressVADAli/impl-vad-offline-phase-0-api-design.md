# Implementation plan — VAD offline Phase 0: API design

**Goal:** Lock **public TypeScript API** and **documentation** for segmented offline VAD + **`onProgress`**, without requiring the full loop implementation yet. Deliver a short **ADR-002** (or `ADR-vad-offline-segmentation.md`) in this folder.

**Depends on:** Alignment [Phase 1](./impl-alignment-phase-1-api.md) patterns (`OrchestrationProgress` re-export, optional callbacks) as **reference**, not as a hard code dependency.

---

## 1. Problem statement

Today ([`src/vad/engine.ts`](../../../src/vad/engine.ts)):

- Offline branch calls **`SherpaOnnx.runVadOffline(instanceId, audioInBufferId, segmentOutBufferId, options)`** once over the **entire** buffer.
- **`VADOfflineRunOptions`** ([`src/vad/types.ts`](../../../src/vad/types.ts)) only has **`sourceTag?: string`**.
- No **`segmentation`**, no **`onProgress`**, no **`abortSignal`**.

**Product target** ([README §3](./README.md)):

- **`segmentation.mode === 'off'`:** preserve **single** `runVadOffline` (legacy default).
- **`segmentation.mode !== 'off'`:** split audio via **segmentation engine**, run VAD **per speech segment**, merge into caller’s **`segmentOut`**, and emit **`OrchestrationProgress`** **before** each native VAD call (same rule as `offlineOrchestrator.reportProgress`).

---

## 2. Proposed public types

### 2.1 Extend `VADOfflineRunOptions`

```ts
import type { OrchestrationProgress } from '../pipeline/offlineOrchestrator';
import type { SegmentationPolicy } from '../segment/engine-types';

export type VADOfflineRunOptions = {
  sourceTag?: string;
  /** When omitted or `mode: 'off'`, single native pass over full audio (today). */
  segmentation?: {
    mode?: 'off' | 'auto'; // 'manual' TBD — align with STT `supportsManual: false` unless product demands manual for VAD
    policy?: SegmentationPolicy;
  };
  onProgress?: (progress: OrchestrationProgress) => void;
  abortSignal?: AbortSignal;
};
```

**Decisions to lock in ADR:**

| Topic | Options |
| --- | --- |
| **`manual` segmentation** | Reject for v1 (like offline STT) **or** allow — pick one. |
| **Default `segmentation`** | `undefined` ⇒ treat as **`off`** (no behaviour change). |
| **`segmentOut` type** | Today `OfflineSegmentBufferIdSource \| LiveSegmentBufferIdSource`. Segmented path may require **offline** only for v1 — document if live segment output is rejected when `segmentation.mode !== 'off'`. |

### 2.2 `VADOfflineResult` extensions (optional)

- Consider returning **`OrchestrationResult`-like** fields (`totalSegments`, `completedSegments`, …) for parity with STT — **optional** ADR choice; minimum is current **`VADSummary` + `segmentBufferId`**.

---

## 3. Native contract spike (blocking design sign-off)

**Questions for native / bridge owners:**

1. Does **`runVadOffline`** accept **sub-range** of an offline buffer (start sample + count), or must TS **materialise** a temporary offline buffer per segment?
2. Peak memory: is per-segment smaller buffer acceptable vs one large pass?
3. **Idempotency:** merging multiple offline VAD outputs into one **`segmentOut`** — is **append** order sufficient, or does native need a single batch?

**Deliverable:** ADR subsection “Native contract” with chosen approach A/B.

---

## 4. Documentation

- **`docs/vad-streaming.md`** or new **`docs/vad-offline.md`:** section **Offline batch** — table: `segmentation.off` vs `auto`, progress, cancellation.
- Cross-link [README §3](./README.md).

---

## 5. ADR outline (ADR-002)

1. Context & current behaviour  
2. Goals / non-goals (streaming unchanged)  
3. Public API (`VADOfflineRunOptions`)  
4. Segmentation policy defaults (reuse **`validateSegmentationConfig`** from STT with tuned **`featureName`** / **`defaultPolicy`** — copy or share helper)  
5. Progress semantics (**identical** to `runOfflineAudioToTextPipeline` `onProgress`)  
6. **Migration / compatibility:** default off  
7. Open questions (performance, semantic change of boundaries)

---

## 6. Exit criteria

- [ ] ADR file committed under `docs/migration/OrchestrationProgressVADAli/`.
- [ ] Types sketch reviewed (may land as **draft** exports behind `@experimental` only if project uses that pattern — otherwise types land in Phase 1).
- [ ] Native spike answered; **no** “TBD” for merge strategy in ADR body.

---

## 7. Non-goals (Phase 0)

- Implementing the segmented loop.
- Changing live VAD pipeline.
