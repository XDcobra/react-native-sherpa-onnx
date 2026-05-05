# Sub-Plan 08: Streaming TTS Deduplication (Post-Implementation Track)

## Status
- Phase: **7 (deferred — explicit exception to the clean-cut rule)**
- Depends on: sub-01 … sub-07 — **all** must be merged, stable, and shipped at least once before this phase begins.
- Blocks: nothing inside this rollout — this is the **final** house-keeping step.

> ⚠️ **Read this first.** Per the rollout principles: "clean cut without legacy logic, exception: StreamingTTS." This sub-plan is the **only** place where a deprecation alias is acceptable. Every other live overload phase (sub-03 … sub-06) does a clean cut without aliases. The reasoning is documented in the design note §7.5: TTS streaming is the precedent that motivated the live overload, and dedup is "important but scheduled later" precisely so we don't block the public release on a dedup design that needs telemetry to validate.

## Purpose

Per design §7.5:

> **After implementation (important, scheduled later):** Deduplication of `createStreamingTTS` vs. the offline-engine live overload — e.g. thin alias, deprecation path, or internal redirect — is **explicitly deferred until the live overloads are complete and stable**. It remains **important** to avoid two divergent public stories long-term; track it as a **post-implementation** cleanup milestone, not as part of the first shipping slice.

This sub-plan resolves that follow-up.

End state: there is **one** way to drive offline TTS weights from a `LiveTextBuffer`. The historical `createStreamingTTS` factory is reduced to a thin redirect (or fully removed in a major version) — no divergent code paths remain.

---

## Why this is its own (deferred) phase

1. **Parity gate**: sub-05 LT-10 is the dedup gate — if the live overload doesn't produce sample-equal output to `createStreamingTTS().synthesize(...)`, dedup is unsafe.
2. **Telemetry**: until the live overload ships in a public release, we don't know which factory users actually adopt. Pre-emptively deprecating one path before users have a chance to validate the other risks churn.
3. **Single release vs. major bump**: full removal of `createStreamingTTS` is a **breaking change**. Aligning that with a planned major version is cleaner than crowbar-ing it into the live overload's first public release.

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

**Start with Option β (internal redirect, no user-facing change). Plan a transition to Option γ (deprecation messaging) once telemetry shows live-overload adoption is ≥30% of new TTS usage.**

Why:

- Pre-release SDK + first public release should not deprecate features the very same release introduced replacements for. Users need time to discover the live overload.
- Internal redirect (β) immediately gives us **single-implementation** safety (one native worker, one Jest path) without imposing migration pain.
- Once the live overload is established (typically one to two minor releases), flipping to γ is mechanical: add `@deprecated`, add `console.warn`, set removal milestone.

This is the path encoded in the implementation plan below.

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

- `tts-streaming.md` collapses the two sections ("Streaming TTS factory" + "Live overload on offline TTS") into **one** section: "Live TTS pipelines (offline weights)". The doc explains both entry points exist, recommends `createTTS().synthesize(...)` for new code, and notes that `createStreamingTTS` is preserved for backward compatibility.

### Step 4 — Deprecation gate (post-telemetry)

Once the live overload has been public for at least one minor release **and** telemetry / community feedback indicates adoption:

- Add `@deprecated` annotation to `createStreamingTTS` JSDoc + TypeScript decorator.
- Add a one-time `console.warn` on first invocation per process.
- Open a tracking issue for full removal at the next major version.

This step is **post-Step 1**, not blocking it. Step 1 ships dedup; Step 4 schedules removal.

### Step 5 — Major-version removal

At the next major (e.g. v1.0):

- Delete `src/tts/streaming.ts` entirely.
- Delete `streamingTtsTypes.ts` types that are not also referenced by the live overload.
- Remove the `StreamingTtsEngine` export from `src/index.ts`.
- Update changelog with explicit "BREAKING" call-out.

---

## What to verify before this phase begins

The trigger for Step 1 is **all** of the following:

- [ ] sub-05 (TTS live overload) is merged, stable, and shipped at least once in a public release.
- [ ] Sub-05 LT-10 (parity test) is green for at least one full release cycle (no regressions filed).
- [ ] No outstanding bug reports against `createTTS().synthesize(LiveText, LiveAudio, ...)` related to audio quality, latency, or `streamingPipelineCompleted` event semantics.
- [ ] Voice cloning live-overload test (LT-7) is green and at least one community example uses voice cloning via the live overload.

If any of these fails, Step 1 is **deferred further**. The clean-cut exception is real but bounded: once sub-08 starts, it must finish.

---

## Acceptance criteria (Step 1 — internal redirect)

- `createStreamingTTS().synthesize(...)` returns the **same** `TtsPipelineHandle` as `createTTS().synthesize(LiveText, LiveAudio, ...)`.
- The native code base contains exactly **one** TTS pipeline worker (`TtsOfflineLivePipelineWorker` from sub-05). `TtsPipelineWorker.kt` / `.mm` are removed.
- All existing streaming-TTS Jest tests pass against the redirect (no behavior change).
- Documentation in `tts-streaming.md` is consolidated.
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

## Open questions

### OQ-8.1 — When in time should Step 1 (internal redirect) actually happen?

**Question.** Should Step 1 land in the **same release** as sub-03 … sub-07, or in the next minor release?

**Recommendation: Next minor release after sub-03 … sub-07 ships.** Reasoning:

- The first public release with the live overload should be **purely additive** — users see the new overload, no factory behavior changes. This minimizes regression risk.
- If we redirect `createStreamingTTS` internally in the same release, any subtle behavior drift between the old and new worker becomes a regression in the same release, not a clean dedup follow-up.
- The next minor release ships with the redirect; users see no behavior change but the dedup is real internally.

### OQ-8.2 — Should `createStreamingTTS` stay listed as a public entry point in the docs after Step 4?

**Question.** Even after `@deprecated` is added, do we keep documenting `createStreamingTTS` as a primary entry point or hide it as "legacy / for backward compatibility"?

**Recommendation: Demote to "legacy" section post-Step 4.** Reasoning:

- Showing two equally-prominent entry points contradicts the deprecation message.
- Keeping the docs page (so existing users can find migration guidance) is important; demoting it to a final "Legacy / migration" section is the right balance.

### OQ-8.3 — How long is "post-telemetry"?

**Question.** Step 4 says "after at least one minor release"; that's a fuzzy timeline. Should we hard-commit to a calendar?

**Recommendation: Hard-commit to "next minor release with at least 30 days of public exposure."** Reasoning:

- A hard floor (≥30 days) prevents the deprecation from racing the release announcement.
- Next-minor cadence gives users one full release cycle to discover the live overload.
- Post-deprecation, removal in the **next major** gives at least another full release cycle of warnings before the breaking change.

If the SDK uses semver-loose versioning (frequent minors), tighten to ≥60 days. The point is to give users a stable window, not to optimize for fast cleanup.

### OQ-8.4 — What about `StreamingTtsEngine` type — same lifecycle as the factory?

**Question.** The `StreamingTtsEngine` interface is defined in `streamingTypes.ts`. Should it follow the same deprecation/removal lifecycle as the factory?

**Recommendation: Yes, but keep its **field shape** identical to the live overload's return.** Reasoning:

- During Step 1 (internal redirect) the type is still used by `createStreamingTTS`'s return value — keep it as-is.
- During Step 4 (deprecation), mark the type `@deprecated` and recommend `TtsEngine` instead.
- During Step 5 (removal), delete the type alongside the factory.

If users imported `StreamingTtsEngine` directly, they get a clean migration path: rename to `TtsEngine`. The field shape remains identical (same `synthesize`, same `getModelInfo`, etc.) so the migration is mechanical.
