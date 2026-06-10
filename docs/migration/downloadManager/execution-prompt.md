# Download Manager Rework — Execution Prompt

> This file contains the **exact prompt** for an implementing agent. Feed the prompt below to a fresh agent session in this repository to drive the rework end-to-end. The prompt is self-contained: it lists every file the agent must read, every sub-plan it must execute, and the per-phase verification rule.

---

## Prompt (copy/paste into a new agent session)

You are an implementing engineer for the `react-native-sherpa-onnx` SDK. Your job is to execute the **Download Manager Rework** end-to-end, in order, **from the first sub-plan to the last**, without skipping or reordering phases.

### Scope reference

Read these documents first, in this order, before writing any code:

1. `docs/migration/downloadManager/download_manager_overview.md` — the high-level plan with phases, target architecture, IST/SOLL summary, and the **frozen** cross-source error contract.
2. `docs/migration/downloadManager/sub-01-source-contract.md` — types, contract, error codes.
3. `docs/migration/downloadManager/sub-02-source-registry-and-builtins.md` — registry + built-in GitHub providers.
4. `docs/migration/downloadManager/sub-03-fetcher-and-headers.md` — fetcher, headers, retry policy (retry off by default).
5. `docs/migration/downloadManager/sub-04-archive-layout-and-extraction-flags.md` — layout, format gates.
6. `docs/migration/downloadManager/sub-05-huggingface-source.md` — Hugging Face provider.
7. `docs/migration/downloadManager/sub-06-download-pipeline-rework.md` — multi-asset engine, cancel, atomic readiness.
8. `docs/migration/downloadManager/sub-07-registry-and-cache-rework.md` — source-aware registry, cache, paths.
9. `docs/migration/downloadManager/sub-08-cleanup-and-test-harness.md` — final parity audit, docs, example app, CHANGELOG.

For background context (do **not** re-execute these plans — they are already implemented; they only show the **conventions** this repo uses for migration plans, sub-plan acceptance, and the per-phase verification cadence):

- `docs/migration/liveOverload/live_overload_overview.md` and its sub-plans.
- `docs/migration/segmentationEngine/segmentation_engine_overview.md` and its sub-plans.

### Files you will modify or read

You will primarily touch the `src/download/` tree, the example app, and the docs. The most important existing files to read **before** starting any phase:

- `src/download/index.ts` (public re-exports — every phase updates this).
- `src/download/types.ts` (`ModelMeta`, `Progress`, `PauseError`, `DownloadOptions`, …).
- `src/download/constants.ts` (`RELEASE_API_BASE` — deleted in phase 2).
- `src/download/paths.ts` (`CATEGORY_CONFIG`, `getReleaseUrl`, model/cache paths — restructured in phases 2, 4, 6, 7).
- `src/download/registry.ts` (`refreshModels`, `fetchChecksumsFromRelease`, asset filters — split across phases 2, 3, 7).
- `src/download/downloadTask.ts` (single-asset engine — rewritten in phase 6).
- `src/download/modelExtraction.ts` (extraction state, native bridge — touched in phases 4, 6).
- `src/download/postDownloadProcessing.ts` (post-download fan-out — becomes commit phase in 6).
- `src/download/ensureModel.ts` (high-level orchestration — touched in 4, 6, 7).
- `src/download/bulkPurge.ts`, `src/download/localModels.ts`, `src/download/protectedModelKeys.ts`, `src/download/activeModelOperations.ts` (source-aware keys + paths in 7).
- `src/download/retry.ts` (**deleted** in phase 3).
- `src/extraction/` (libarchive bindings — no behavioural change, only awareness).
- `android/src/main/cpp/jni/archive/sherpa-onnx-archive-helper.cpp` — function `ConfigureArchiveFormats(...)`. **Read** to derive the set of archive formats `SUPPORTED_ARCHIVE_FORMATS` is allowed to contain (sub-04). Do **not** modify.
- `ios/archive/sherpa-onnx-archive-helper.mm` — same function on iOS; must register the **same** set of filters. Do **not** modify.
- `third_party/libarchive_prebuilt/build_libarchive_android.sh` — CMake flags (`-DENABLE_*`) decide which decoders are actually linked into the Android prebuilt. **Read** before phase 4 and intersect with the helper's filters.
- `third_party/libarchive_prebuilt/build_libarchive_ios.sh` — same for iOS. **Read** before phase 4 and intersect with the helper's filters.
- `example/src/screens/download-showcase/DownloadShowcaseScreen.tsx` (showcase — extended in phase 8).
- `docs/download-manager.md` (public docs — rewritten in phase 8).
- `CHANGELOG.md` (breaking entry in phase 8).

You will create the following new files (per the sub-plans):

- `src/download/sources/types.ts`
- `src/download/sources/errors.ts`
- `src/download/sources/index.ts`
- `src/download/sources/registry.ts`
- `src/download/sources/github-common.ts`
- `src/download/sources/fetch.ts`
- `src/download/sources/formats.ts`
- `src/download/sources/builtin/github-k2-fsa.ts`
- `src/download/sources/builtin/github-xdcobra.ts`
- `src/download/sources/builtin/huggingface.ts`
- `src/download/sources/builtin/huggingface-defaults.ts`
- `src/download/sources/builtin/index.ts`
- `src/download/migration/legacyPurge.ts`
- Per-sub-plan `__tests__/*.test.ts` files (see each sub-plan's "Files to add").

### Rules of execution (apply throughout)

1. **Sequential, from first to last sub-plan.** Implement sub-01 fully → run its tests → audit → only then start sub-02. Repeat. **The task is not complete until sub-08 is fully implemented and accepted.** Do not skip a sub-plan, do not implement sub-N+1 details ahead of time.

2. **IST/SOLL review at each phase boundary.** After each sub-plan's implementation steps and tests pass, perform an explicit comparison of the **current state of the code (IST)** with the **target described in the sub-plan + the overview (SOLL)**. Write the findings into the audit table inside `docs/migration/downloadManager/sub-08-cleanup-and-test-harness.md` (Workstream 1). If any deviation is found, **implement the fix inside the current phase before advancing**. Do not defer deviations to a later sub-plan unless the deviation is explicitly listed as an "acceptable-deviation" in the sub-plan itself.

3. **Clean cut, no legacy code paths.** The SDK is pre-release and not yet shipped. Do not introduce deprecation aliases for `archiveExt`, `downloadUrl`, `RELEASE_API_BASE`, `getReleaseUrl`, or `retryWithBackoff`. Replace them outright. If a phase finishes and any of these symbols still exist in `src/`, that's an IST/SOLL deviation.

4. **Frozen error contract.** The error codes in the overview's "Cross-source error contract" table are the **only** codes you produce. Adding a new code requires an explicit edit of the overview *and* of `DOWNLOAD_ERROR_CODES` in `src/download/sources/errors.ts`. Do not silently mint new strings.

5. **Retry off by default.** `RequestPolicy.retries` defaults to `0` everywhere. The production code path in `refreshModels`/`downloadModel`/`ensureModel`/`extractModel` never calls `retryWithBackoff` or runs an implicit retry loop. The only retries that exist are those a caller opted into via `requestPolicy`. Verify with `rg retryWithBackoff src/` returning empty after phase 3.

6. **Tokens are never logged.** Per sub-03, `Authorization` headers are built inside `sourceFetch` and never appear in error messages. Add a unit test for this in phase 3 (already in the test matrix).

7. **Atomic readiness for multi-file folders.** Per sub-06, temp folder → final folder rename is the only commit step. No `finalDir` is materialized until every asset is on disk and (for archive layouts) extracted. A successful run leaves no `.tmp-*` folder behind; a failed/cancelled run leaves no `finalDir`.

8. **Source identity is part of identity.** Per sub-07, `ModelMeta.sourceId` is required and the cache + model dir path layout is source-namespaced. Default routing keeps today's behaviour intact for callers that don't opt in to a different source.

9. **Tests are mandatory per sub-plan.** Every sub-plan's "Test matrix" must pass before you advance. Jest stability is part of the phase's acceptance — don't drop or silently skip suites; fix tooling instead.

10. **Documentation and CHANGELOG stay in lock-step.** The final doc rewrite happens in sub-08, but every sub-plan that adds public types/functions must update `src/download/index.ts` re-exports immediately, so the consumer-facing surface is always coherent.

11. **No native code change in this rework** (beyond reading existing native extractor capabilities). The additional archive filters this rework exposes to JS are already implemented native-side; you only flip JS gates. **Before phase 4 starts**, re-read `android/src/main/cpp/jni/archive/sherpa-onnx-archive-helper.cpp`, `ios/archive/sherpa-onnx-archive-helper.mm`, `third_party/libarchive_prebuilt/build_libarchive_android.sh`, and `third_party/libarchive_prebuilt/build_libarchive_ios.sh`. Build the intersection of "filter registered in helper" × "decoder enabled by both build scripts". That intersection is what `SUPPORTED_ARCHIVE_FORMATS` and `SourceArchiveFormat` must list. If the helper registers a filter that the build scripts disable, **do not** add that format — runtime would fail.

12. **Archive-as-root invariant.** Extraction in the JS layer happens **only** when a model's single asset *is* the archive containing the model root (`layout.kind === 'archive' && layout.extract === true`). A folder-layout model is **never** unpacked, even if one of its assets has an archive extension (`.tar.bz2`, `.tar.gz`, `.tar.xz`, `.tar.zst`). After sub-06, `rg "extractArchive" src/download/` must show **exactly one** call site — inside `commitModel`'s archive-extract branch. Any second call site is a bug.

13. **Use the tooling already in this repo.** Run `yarn lint`, `yarn typecheck`, and the appropriate `yarn test` invocations defined in `package.json`. If a phase fails CI on Android or iOS, treat that as `must-fix-before-release`.

### Per-phase verification cadence

For each phase, perform the following loop:

> **Plan → Implement → Test → IST/SOLL audit → Iterate or advance.**

Concretely, at each phase boundary:

1. Read the sub-plan in full one more time before starting (the relevant doc only).
2. Implement the "Implementation steps" exactly. If a step is unclear, prefer the spec in the sub-plan; only escalate (ask the user) if the sub-plan is genuinely ambiguous.
3. Add the sub-plan's Jest matrix in full. Don't trim or rename test cases — they're the contract.
4. Run the new tests + the full pre-existing download test suite. Both must pass.
5. Audit `src/` against the sub-plan: every "Files to add / modify" entry should match. Every "Acceptance criteria" bullet should be ticked.
6. Run a small end-to-end smoke when the sub-plan calls for it (sub-04, sub-05, sub-06, sub-07 all include smoke checklists).
7. Open `docs/migration/downloadManager/sub-08-cleanup-and-test-harness.md` (Workstream 1) and add an audit-table row for the phase: phase, status, code references, any deviation, classification.
8. Only after the audit row is clean → advance to the next phase.

### Definition of done (whole-rework)

The task is complete when:

- All eight sub-plans (sub-01 … sub-08) are implemented and their acceptance criteria are checked.
- The cross-source matrix (sub-08, Workstream 2) is green.
- The example showcase (sub-08, Workstream 3) downloads from at least two sources end-to-end.
- `docs/download-manager.md` is rewritten per sub-08, Workstream 4.
- The CHANGELOG breaking entry is added per sub-08, Workstream 5.
- Native builds on Android + iOS are green per sub-08, Workstream 6.
- The audit table in sub-08 lists every phase with `must-fix-before-release` count = 0.
- `rg` for forbidden strings (`archiveExt`, `downloadUrl` on `ModelMeta`, `RELEASE_API_BASE`, `releaseApiBase`, `retryWithBackoff`, `getReleaseUrl`) returns no hits in `src/`.

Until **all** of the above are true, the rework is **not complete**. Specifically: completion is tied to **finishing the last sub-plan (sub-08)** including the audit, the docs, and the CHANGELOG.

---

### Requirements recap (from the user)

The rework is driven by these explicit user requirements (already encoded across the sub-plans; re-stated here so the implementing agent can sanity-check against them):

- Currently we have GitHub as the source of truth (`https://github.com/k2-fsa/sherpa-onnx`; for alignment `https://github.com/XDcobra/react-native-sherpa-onnx`).
- GitHub can be slow; a select-server logic should let consumers switch between source servers and set their own.
- Built-in sources: GitHub `k2-fsa`, GitHub `XDcobra`, and **Hugging Face**.
- Hugging Face works differently: model files are **individual**, not bundled in an archive. The provider talks to the HF Hub API; a useful reference is the HF blog at `https://huggingface.co/blog/llm-inference-on-edge`.
- Because layouts diverge (archive vs. folder, possibly with different formats), the abstraction must support dynamic flags: extract yes/no, archive format (must be supported by the built-in libarchive — the supported set is the intersection of filters registered in `ConfigureArchiveFormats(...)` in the native helpers and decoders enabled by both libarchive build scripts; see sub-04 → "Supported formats (source of truth)"), archive vs. folder.
- **Native extraction only when the archive is the model root.** If a folder-layout model happens to contain a `.tar.bz2` (or any other archive-extension file) in a sub-directory, that file must **not** be extracted — it is committed to disk as a plain file. Extraction is gated by `layout.kind === 'archive' && layout.extract === true`, never by filename.
- The download package already handles a lot of cancellation work, but we still need a robust cleanup/abort tactic.
- Deterministic error codes; no arbitrary retry. Retry is off by default and only enabled via flag.
- Custom headers must be settable per source (HF token, GitHub token to avoid rate limits, arbitrary custom-server headers).
- Clean cut, robust implementation — the SDK is public but **not yet released**, so no legacy compat shims.

These requirements are the canonical source for resolving any future ambiguity; the sub-plans are derived from them.

---

## End of prompt
