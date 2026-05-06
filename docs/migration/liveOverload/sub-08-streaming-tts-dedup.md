# Sub-Plan 08: Streaming TTS Deduplication (Post-Implementation Track)

Companion references:
- [Design note: offline-stt-live-pipeline-mandatory-segmentation.md](./offline-stt-live-pipeline-mandatory-segmentation.md)
- [Phase overview: live_overload_overview.md](./live_overload_overview.md)

## Status
- Phase: **8 (minor breaking rollout completed)**
- Depends on: sub-01 … sub-07 — all must be implemented and verified before this phase begins.
- Blocks: none.

> ⚠️ **Read this first.** Per the rollout principles: "clean cut without legacy logic, exception: StreamingTTS." This sub-plan is the **only** place where a compatibility alias is acceptable. Every other live overload phase (sub-03 … sub-06) does a clean cut without aliases. For this project, dedup is executed in the same release after sub-01 … sub-07 are complete.

## Purpose

Per design §7.5:

> **After implementation (important, scheduled later):** Deduplication of `createStreamingTTS` vs. the offline-engine live overload — e.g. thin alias, deprecation path, or internal redirect — is **explicitly deferred until the live overloads are complete and stable**. It remains **important** to avoid two divergent public stories long-term; track it as a **post-implementation** cleanup milestone, not as part of the first shipping slice.

This sub-plan resolves that follow-up.

End state: there is **one** way to drive offline TTS weights from a `LiveTextBuffer`. The historical `createStreamingTTS` factory is reduced to a thin redirect (or fully removed in a major version) — no divergent code paths remain.

---

## Why this is its own final phase

1. **Parity gate**: sub-05 LT-10 is the dedup gate — if the live overload doesn't produce sample-equal output to `createStreamingTTS().synthesize(...)`, dedup is unsafe.
2. **Release sequencing**: dedup is intentionally placed at the end of the implementation train so parity work can settle first.
3. **Future removal remains breaking**: full removal of `createStreamingTTS` is still a major-version concern; this phase performs dedup/redirect in-place.

---

## Scope

This sub-plan **resolves** at minimum the following:

- Define the dedup strategy (thin alias / internal redirect / hard deprecation).
- Migrate the existing streaming-TTS native worker to the shared `OfflineLivePipelineWorker` base.
- Update tests to share fixtures.
- Update docs.
- Author the deprecation notice and removal milestone.

It explicitly does **not** touch:
- STT, Punctuation, Enhancement live overloads (those have **different** model weights — no dedup question).
- Streaming pipeline registry, segmentation engine, completion event plumbing — all reused unchanged.

---

## Strategy options (analysis)

### Option α — Thin alias

`createStreamingTTS(...)` becomes a thin wrapper that:

1. Calls `createTTS(...)` with the same init options.
2. Returns an object whose `synthesize(textIn, audioOut, options?)` simply delegates to `tts.synthesize(textIn, audioOut, mergedOptions)` — but with a default `segmentation.policy` injected when the caller didn't supply one (since the live overload requires it but `createStreamingTTS` historically didn't).
3. `console.warn` once per process: `[deprecated] createStreamingTTS will be removed in vX.Y. Use createTTS().synthesize(liveText, liveAudio, { segmentation: { policy: ... } })`.

Pros: minimal user disruption, no breaking change today.
Cons: keeps two public entry points alive long-term; warns users who haven't asked for guidance.

### Option β — Internal redirect, no deprecation messaging yet

Same as α, but **without** the `console.warn`. The dedup is purely internal: `createStreamingTTS` and `createTTS().synthesize(live, ...)` share the same native worker, but both are documented as **valid public entry points** until a future major.

Pros: zero user-facing churn; gives time to gather telemetry.
Cons: documentation must keep two entry points consistent; risk that users settle into `createStreamingTTS` and never migrate.

### Option γ — Hard deprecation in the next minor, removal in the next major

`createStreamingTTS` is marked `@deprecated` in `streamingTypes.ts`. Users see linter warnings. The factory still functions (delegated as in α). Removal scheduled at the next major (e.g. v1.0).

Pros: explicit migration path; matches typical SDK deprecation lifecycle.
Cons: requires a defined major-version timeline; deprecation in a pre-release SDK can feel premature.

### Option δ — Hard removal, no alias

Delete `createStreamingTTS` entirely. Documented as a **breaking change** in the next minor.

Pros: cleanest code; one entry point.
Cons: breaking change for existing users; collides with the otherwise additive nature of this rollout.

### Recommendation

**Use Option δ in this minor release (hard removal, no alias).**

`createStreamingTTS` and `StreamingTtsEngine` are removed. Live pipelines must use `createTTS().synthesize(LiveText, LiveAudio, { segmentation })`.

---

## Implementation plan

### Step 1 — Native worker dedup (zero user-facing change)

After sub-05 ships and `TtsOfflineLivePipelineWorker` (extending `OfflineLivePipelineWorker`) is the live-overload worker, the existing `TtsPipelineWorker` (used by `createStreamingTTS`) becomes a strict superset of behavior — same drain loop, same per-segment synth, same completion event.

Action:

- In `src/tts/streaming.ts`, change `createStreamingTTS()`'s `synthesize()` to **internally call** the live-overload entry. Specifically:

```ts
// streamingTtsEngine.synthesize(textIn, audioOut, opts?)
// becomes:
const tts = await createTTS(initOptionsFromStreamingFactory);
return tts.synthesize(textIn, audioOut, {
  segmentation: opts?.segmentation
    ? toLiveOverloadSegmentation(opts.segmentation)
    : { policy: { evaluator: 'text_synthetic_auto', maxLengthChars: 500 } }, // default
  sid: opts?.sid,
  speed: opts?.speed,
  voiceClone: opts?.voiceClone,
});
```

- Mirror this in native: `startStreamingTtsPipeline` (the existing TurboModule call backing `createStreamingTTS`) is reimplemented to **call** `startTtsOfflineLivePipeline` internally with a default `segmentation.policy` if the streaming-TTS caller passed none.
- Delete `TtsPipelineWorker.kt` / `TtsPipelineWorker.mm` once the redirect is in place. The shared `TtsOfflineLivePipelineWorker` (sub-05) is the only TTS worker.

**Public surface**: `createStreamingTTS` and `createTTS` both remain. `createStreamingTTS().synthesize(...)` is now a thin wrapper. **No breaking change.**

### Step 2 — Test harness consolidation

- Move the existing `streaming-mode4-segmentation.test.ts` and related streaming-TTS suites under a shared describe-block parameterized by **factory choice**: `createStreamingTTS` vs `createTTS`. Both call paths assert the same outputs.
- Remove duplicated fixtures.

### Step 3 — Docs consolidation

- `tts-offline.md` is the canonical public doc for live TTS pipelines on offline weights (`createTTS().synthesize(LiveText, LiveAudio, { segmentation })`).

### Step 4 — Deprecation gate (optional follow-up)

If/when the team decides to introduce explicit deprecation messaging:

- Add `@deprecated` annotation to `createStreamingTTS` JSDoc + TypeScript decorator.
- Add a one-time `console.warn` on first invocation per process.
- Open a tracking issue for full removal at the next major version.

This step is optional for the same-release rollout and does not block dedup completion.

### Step 5 — Major-version removal

At the next major (e.g. v1.0):

- Delete `src/tts/streaming.ts` entirely.
- Delete `streamingTtsTypes.ts` types that are not also referenced by the live overload.
- Remove the `StreamingTtsEngine` export from `src/index.ts`.
- Update changelog with explicit "BREAKING" call-out.

---

## What to verify before this phase begins

The trigger for Step 1 in this release is **all** of the following:

- [ ] sub-05 (TTS live overload) is merged and stable in the current branch.
- [ ] Sub-05 LT-10 (parity test) is green in current CI.
- [ ] No outstanding bug reports against `createTTS().synthesize(LiveText, LiveAudio, ...)` related to audio quality, latency, or `streamingPipelineCompleted` event semantics.
- [ ] Voice cloning live-overload test (LT-7) is green and at least one community example uses voice cloning via the live overload.

If any of these fails, Step 1 is deferred until fixed. The clean-cut exception is real but bounded: once sub-08 starts, it must finish in the same release train.

---

## Acceptance criteria (Step 1 — internal redirect)

- `createStreamingTTS().synthesize(...)` returns the **same** `TtsPipelineHandle` as `createTTS().synthesize(LiveText, LiveAudio, ...)`.
- The native code base contains exactly **one** TTS pipeline worker (`TtsOfflineLivePipelineWorker` from sub-05). `TtsPipelineWorker.kt` / `.mm` are removed.
- All existing streaming-TTS Jest tests pass against the redirect (no behavior change).
- Documentation in `tts-offline.md` reflects the live-overload-only entrypoint.
- No `console.warn` yet.

## Acceptance criteria (Step 4 — deprecation messaging)

- `createStreamingTTS` JSDoc carries `@deprecated`.
- One-time `console.warn` fires on first call per process.
- TypeScript editor surfaces deprecation strikethrough.
- Removal milestone tracked in `CHANGELOG.md` / GitHub project board.

## Acceptance criteria (Step 5 — removal)

- `src/tts/streaming.ts` deleted.
- All references in `src/index.ts`, native code, and tests removed.
- Changelog has a `BREAKING:` entry.
- Migration guide section added to docs (`docs/migration/streaming-tts-removal.md`).

---

## Resolved decisions

### OQ-8.1 — When in time should Step 1 (internal redirect) actually happen?

**Decision: Same release as sub-03 … sub-07 (accepted).**

Because the public SDK has not been published yet, dedup is executed in the same release train after sub-phases 01–08 implementation is complete and verified.

### OQ-8.2 — Should `createStreamingTTS` stay listed as a public entry point in the docs after Step 4?

**Decision: Demote to a \"legacy\" section post-Step 4 (accepted).**

### OQ-8.3 — How long is "post-telemetry"?

**Decision: Dedup in the same release after sub-phases 01–08 are finished (accepted).**

No waiting window/post-telemetry gate is required for dedup execution in this rollout.

### OQ-8.4 — What about `StreamingTtsEngine` type — same lifecycle as the factory?

**Decision: Yes, same lifecycle; keep field shape identical to the live-overload return (accepted).**

If/when deprecation/removal occurs, `StreamingTtsEngine` follows the factory lifecycle, and remains mechanically migratable because shape parity is preserved.
