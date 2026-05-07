# Sub-Plan 07: Cleanup, Cross-Feature Test Matrix & Example App Integration

## Status
- Phase: **6**
- Depends on: sub-01 … sub-06.
- Prerequisite for: sub-08 (TTS dedup) — that phase **assumes** all four features are stable and the parity gate is green.

## Purpose

Final hardening pass before the live overload ships:

1. **Contract parity audit** (Doc vs. Code) for sub-01 … sub-06.
2. **Cross-feature test matrix** — make sure the overall contract holds uniformly across STT, Punctuation, TTS, Enhancement.
3. **Example app integration** — wire the live overload into the existing live pipeline showcase screen so users have something to play with.
4. **Documentation closure** — update the public docs (`stt-offline.md`, `tts-offline.md`, `enhancement-streaming.md`, `punctuation.md`) with "Live overload" sections that link back to the design note.
5. **Native build verification** — Android + iOS compile clean; example app smoke-tests pass on both platforms.

After this phase, the live overload feature is **release-ready**, except for the explicitly deferred TTS dedup (sub-08).

---

## Workstream 1 — Contract parity audit

For each requirement in sub-01 through sub-06, mark **Implemented**, **Partially implemented**, or **Missing**, attach concrete code references, and classify as `must-fix-before-release` or `acceptable-deviation` (with rationale).

Audit checklist anchored to the design note's acceptance criteria (§8):

- [ ] **§8.1** — Offline batch overload byte-for-byte unchanged.
  - Spot-check: signature diff against `git tag pre-live-overload` is **empty** for the batch overload methods on STT / TTS / Punctuation / Enhancement.
- [ ] **§8.2** — Live overload requires `segmentation.policy`; missing/`off` policy fails deterministically.
  - Verified by sub-01 unit tests + each per-feature negative test.
- [ ] **§8.3** — Live overload returns the existing `<Feature>PipelineHandle` and integrates with `streamingPipelineCompleted`.
  - Verified by each per-feature golden-path test.
- [ ] **§8.4** — Per-feature decisions per §5.1 (a/b/c/d). For (b)-Enhancement, non-`continuous_frames` policies rejected.
  - Verified by enhancement test LE-3, LE-4.
- [ ] **§8.5** — Flush/stop semantics per §7.2 (`flush` → detach `flushFinal: true` + drain; `stop` → cancel + detach).
  - Verified by per-feature flush/stop tests (e.g. L-6/L-7 in STT, LP-6/LP-7 in punctuation, LT-8/LT-9 in TTS, LE-6/LE-7 in enhancement).
- [ ] **§8.6** — Tests:
  - Golden path per feature.
  - Negative path: missing policy → `LIVE_OFFLINE_SEGMENTATION_REQUIRED`.
  - Enhancement-specific: non-`continuous_frames` rejected.

Audit lives in this sub-plan as a **table** (rather than a separate file) since the live overload's surface is small enough to track inline.

---

## Workstream 2 — Cross-feature test matrix (Jest)

A small set of **cross-feature** tests verify uniform contract behavior beyond the per-feature suites. Co-locate in `src/livePipeline/__tests__/cross-feature.test.ts`.

| # | Test | What it verifies |
|---|---|---|
| X-1 | **Error code parity**: invoke the missing-policy negative test on STT, Punctuation, TTS, Enhancement; assert all four throw `LiveOfflinePipelineError` with `code === 'LIVE_OFFLINE_SEGMENTATION_REQUIRED'`. | Single error code, no feature-specific subcode drift. |
| X-2 | **Handle type parity**: invoke each feature's golden path with stubbed native bridge; assert returned handle has `pipelineId`, `instanceId`, `completed`, `stop`, `flush`, `reset`, `getStatus`. | Returned handles share the streaming-pipeline contract. |
| X-3 | **`completed` event parity**: each feature's pipeline → trigger native completion event with `reason: 'completed'`; assert `await handle.completed` resolves with the same shape. | Cross-feature event payload symmetry. |
| X-4 | **Detach-on-stop parity**: each feature's pipeline → call `stop()`; assert `detachSegmentationEngine` is invoked exactly once (mock the segmentation registry). | No segmentation-engine leaks across features. |
| X-5 | **No `onPartial` mistakenly exposed**: type-level test using `expect-type` confirms none of the four `<Feature>LivePipelineOptions` types contains an `onPartial` field. | Design §7.1 — partials are off-limits for live overload. |

These tests are kept lean — they verify **uniformity**, not feature behavior (already covered by sub-03 … sub-06).

### Jest/tooling stability requirements

Jest execution stability is part of the contract for this phase. A green matrix is only valid when the required suites can run reliably.

- [ ] If required suites fail due to runner/config/tooling issues (for example ESM transform/import parsing in dependencies), classify as `must-fix-before-release` in the parity audit.
- [ ] Do not drop or silently skip required suites because of environment issues. Either fix configuration/tooling, or keep the phase blocked.
- [ ] Keep one canonical reproducible command set (local + CI) for: per-feature suites, cross-feature matrix, and baseline regression suites.
- [ ] For each completed phase, verify both newly added suites **and** pre-existing baseline suites in the same feature area.

Example blocker class: Jest failing before test execution due to module-format mismatch in transitive dependencies.

---

## Workstream 3 — Example app integration

The example app already has a **live pipeline showcase screen** at `example/src/screens/live-pipeline-showcase/LivePipelineShowcaseScreen.tsx`. Extend it (or add a sibling screen, see OQ-7.1) so users can demo the live overload.

### Required demos

1. **STT live overload** — pick an offline-only model (e.g. Whisper-tiny or SenseVoice-small from the example's model registry) → record from mic into `LiveAudioBuffer` → run `tts.transcribe(liveAudio, liveText, { segmentation: { policy: { evaluator: 'speech_energy_silence' } } })` → display committed text segments.
2. **One additional feature** — pick **either** TTS or Enhancement live overload to demonstrate cross-feature applicability. Recommendation: **TTS** because it's the most user-visible (typing into a `LiveTextBuffer` and hearing per-segment audio is a striking demo).

Punctuation and Enhancement live demos are **nice to have** but not required for release — covered by tests.

### UI changes

- Home screen (`example/src/screens/home/HomeScreen.tsx`): the existing "Live Pipeline" entry continues to point at the live showcase screen. Add a sub-section header inside that screen for "Offline weights, live pipeline (NEW)".
- Live showcase screen: add a toggle for engine kind ("streaming engine" vs "offline engine + live overload"). The toggle determines which `createX` factory is used, and which method overload is called. Keep the surrounding mic / playback UI identical so users can A/B compare.
- **Model filtering must react to selected engine kind**:
  - streaming-only path: show only streaming-capable models.
  - live-overload path (offline factory + live overload): show offline-capable models; where both kinds are supported, show both with explicit badges.
  - if live-overload path is selected, do not offer `segmentation.mode = 'off'`; show an inline hint that segmentation is mandatory in this configuration.
- Apply this behavior not only to `LivePipelineShowcaseScreen`, but consistently across relevant feature screens (`STTScreen`, `STTStreamingScreen`, `OfflineTTSScreen`, `StreamingTTSScreen`, `PunctuationScreen`, `PunctuationStreamingScreen`, `EnhancementScreen`, `EnhancementStreamingScreen`) once phases are implemented.
- Introduce a shared React UI abstraction to avoid duplication:
  - either extend current shared controls (`SegmentationPolicyControls`) or add a new common component (recommended: `EngineModeModelSelector`) that centralizes:
    - engine-mode toggle
    - model capability filtering
    - segmentation mandatory-state UX (including disabled `off` mode + explanatory hint)
  - screen-level code should provide feature-specific capability predicates; shared component owns rendering/UX logic.

### Non-goals

- Voice-clone live demo for TTS — voice-clone setup is heavy enough to merit its own screen; skip for the rollout.
- Enhancement live demo — verify the artifact disclaimer renders, but a real-time A/B audio comparison is out of scope (would require simultaneous online + offline pipelines on the same input — non-trivial UI).

---

## Workstream 4 — Public documentation updates

Update existing docs to land "Live overload" sections. Each section follows a uniform template:

```md
## Live overload (offline weights, live consumption)

> Available since v0.X. Mandatory `segmentation.policy`. Commit-only — no partials.

```ts
const engine = await createX({ /* offline init */ });
const pipeline = await engine.<method>(liveIn, liveOut, {
  segmentation: { policy: { evaluator: '<default>' /* … */ } },
});
// pipeline.stop() / .flush() / .completed as usual
```

| Aspect | Live overload (`createX`) | Streaming engine (`createStreamingX`) |
| --- | --- | --- |
| Decoder | offline | online |
| Partials | no | yes |
| ... | ... | ... |

See [SDK extension design note](./migration/liveOverload/offline-stt-live-pipeline-mandatory-segmentation.md).
```

Files to update:

| Doc | Change |
|---|---|
| `docs/stt-offline.md` | Add **"Live overload"** section. |
| `docs/stt-streaming.md` | Add cross-link to STT live overload as the offline-weights alternative. |
| `docs/tts-offline.md` | Add/maintain **"Live overload on offline TTS"** section. |
| `docs/enhancement-streaming.md` (or `docs/enhancement-offline.md` if that's where the offline path lives) | Add **"Live overload on offline enhancement (restricted)"** section with the artifact disclaimer. |
| `docs/punctuation.md` (or feature equivalent) | Add **"Live overload on offline punctuation"** section. |
| `docs/segmentation-engine.md` | Add a small **"Live overload integration"** call-out describing how the segmentation engine is the runtime for the live overload. |
| Top-level README | One-line entry under "What's new" linking to the design note. |

---

## Workstream 5 — Native build verification

Run on a clean checkout of the merged feature branch:

```bash
# Android
cd example && yarn install --immutable
yarn android        # builds & launches on connected device/emulator

# iOS
cd ios && pod install
cd ..
yarn ios            # builds & launches on simulator
```

Verify:

- Both builds compile clean (zero new warnings beyond pre-existing baseline).
- Example app smoke test for **STT live overload** + **one additional feature** completes without native crashes.
- `streamingPipelineCompleted` events fire for the new pipelines and carry `unitsRead` / `unitsWritten` consistent with what the JS test expects.

---

## Workstream 6 — Cleanup audit (clean-cut rule)

Per the rollout principle ("clean cut without legacy logic, exception: StreamingTTS"):

- [ ] No `@deprecated` annotation introduced anywhere in this rollout (sub-01 … sub-06).
- [ ] No alias / shim layer in the native code other than the shared-base subclassing.
- [ ] `createStreamingPunctuation`, `createStreamingEnhancement`, `createStreamingSTT` — **all unchanged**. (Different model weights — no dedup question.)
- [ ] `createStreamingTTS` — **untouched** (intentional; sub-08 owns it).
- [ ] Old streaming pipeline workers (e.g. `SttPipelineWorker`, `TtsPipelineWorker`, `PunctuationPipelineWorker`, `EnhancementPipelineWorker`) are still around — they remain the implementation for the **online** path. Do **not** retrofit them onto the shared base; that's a separate refactor outside this rollout's scope.

---

## Workstream 7 — Release notes

Draft release notes targeting the next public version. Sample structure:

```md
## NEW: Live overload on offline engines

Offline-only models can now drive a live pipeline directly:

- `createSTT().transcribe(liveAudio, liveText, { segmentation: { policy } })`
- `createTTS().synthesize(liveText, liveAudio, { segmentation: { policy } })`
- `createOfflinePunctuation().punctuate(liveText, liveText, { segmentation: { policy } })`
- `createEnhancement().enhance(liveAudio, liveAudio, { segmentation: { policy: { evaluator: 'continuous_frames' } } })`

`segmentation.policy` is mandatory. Missing policy throws `LIVE_OFFLINE_SEGMENTATION_REQUIRED`.

See the [design note](./docs/migration/liveOverload/offline-stt-live-pipeline-mandatory-segmentation.md).

### Limitations
- No partial / mid-utterance hypotheses (use `createStreamingX` for partials).
- Enhancement live overload is restricted to `continuous_frames` policy and may produce boundary artifacts.

### Known follow-ups
- `createStreamingTTS` deduplication tracked separately (`docs/migration/liveOverload/sub-08-streaming-tts-dedup.md`).
```

---

## Acceptance criteria

- [ ] Contract parity audit table is filled in and **all** items are `Implemented` (no `must-fix-before-release` items remaining).
- [ ] Cross-feature test matrix (X-1 … X-5) is implemented and green.
- [ ] Jest/tooling stability requirements are satisfied (no unresolved required-suite runner/config blockers).
- [ ] Example app live showcase demoes STT live overload + one additional feature.
- [ ] All listed docs updated with the "Live overload" section.
- [ ] Android + iOS example apps build clean with no new warnings.
- [ ] Release notes drafted and tracked.
- [ ] No deprecated / alias code shipped (other than the deferred `createStreamingTTS` track in sub-08).

---

## Open questions

### OQ-7.1 — New screen vs. extension of existing live showcase?

**Question.** The existing `LivePipelineShowcaseScreen` already demos online streaming pipelines. Should the live overload be:
(a) An additional toggle on the existing screen ("streaming engine" vs "offline engine + live overload"),
(b) A new sibling screen `LiveOverloadShowcaseScreen`?

## Resolved decisions

### OQ-7.1 — New screen vs. extension of existing live showcase?

**Decision: (a) Extend existing screen (accepted).**

Implementation constraints:

- Keep one showcase screen and add an engine-mode toggle.
- Model lists must be capability-aware per mode (streaming-only vs live-overload/offline-factory path).
- Where both model kinds are valid, show both with clear labels/badges.
- In live-overload mode, do not expose `segmentation.mode='off'`; show an explanatory hint that segmentation is mandatory in this setup.
- Roll out the same behavior across all relevant feature screens, not just `LivePipelineShowcaseScreen`.
- Use a shared React abstraction to avoid duplicated UI/logic (extend existing shared controls or add a new common selector component).

### OQ-7.2 — Should we deprecate any existing test files?

**Decision: Keep them all (accepted).**

Do not remove existing streaming test suites in this phase; test cleanup remains explicitly deferred to sub-08 where applicable.

### OQ-7.3 — Should this sub-plan also do a migration-doc parity audit (analogous to segmentation engine sub-06 workstream 1)?

**Decision: Yes, but compressed (accepted).**

Use the compressed parity checklist in Workstream 1 (acceptance-criteria-based audit), not a full method-by-method matrix.
