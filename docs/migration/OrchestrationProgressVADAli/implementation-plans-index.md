# Implementation plans — index

Concrete execution plans for the phases in [README §2–3](./README.md). **Phase 0 (alignment)** is design-complete ([ADR-001](./ADR-001-alignment-progress-strategy.md), [phase-0](./phase-0-alignment-progress-semantics.md)); no separate implementation plan.

VAD Phase 0 design decisions are locked in [ADR-002](./ADR-002-vad-offline-segmentation-progress-strategy.md).

| Track | Phase | Document |
| --- | --- | --- |
| **Alignment** | 1 — API surface | [impl-alignment-phase-1-api.md](./impl-alignment-phase-1-api.md) |
| **Alignment** | 2 — Accurate auto drivers | [impl-alignment-phase-2-accurate-drivers.md](./impl-alignment-phase-2-accurate-drivers.md) |
| **Alignment** | 3 — Remaining modes | [impl-alignment-phase-3-remaining-modes.md](./impl-alignment-phase-3-remaining-modes.md) |
| **Alignment** | 4 — Docs & release | [impl-alignment-phase-4-docs-release.md](./impl-alignment-phase-4-docs-release.md) |
| **VAD offline** | 0 — API design | [impl-vad-offline-phase-0-api-design.md](./impl-vad-offline-phase-0-api-design.md) |
| **VAD offline** | 1 — Segment + loop | [impl-vad-offline-phase-1-segment-loop.md](./impl-vad-offline-phase-1-segment-loop.md) |
| **VAD offline** | 2 — Progress | [impl-vad-offline-phase-2-progress.md](./impl-vad-offline-phase-2-progress.md) |
| **VAD offline** | 3 — Edge cases | [impl-vad-offline-phase-3-edge-cases.md](./impl-vad-offline-phase-3-edge-cases.md) |

**Suggested order:** Alignment 1 → 2 → (3 ∥ partial 4) → 4 closure; then VAD 0 → 1 → 2 → 3.
