# Sub-Plan 08: Cleanup, Cross-Source Parity Audit, Test Matrix, Example App & Docs

## Status
- Phase: **8** (final)
- Depends on: sub-01 … sub-07.
- Prerequisite for: nothing — this sub-plan closes the rework.

## Cross-references
- Overview: [`download_manager_overview.md`](./download_manager_overview.md)
- Public docs to refresh: [`docs/download-manager.md`](../../download-manager.md)
- Example showcase: [`example/src/screens/download-showcase/DownloadShowcaseScreen.tsx`](../../../example/src/screens/download-showcase/DownloadShowcaseScreen.tsx).
- CHANGELOG: `CHANGELOG.md` (repo root).
- Comparable closure phase pattern: [`docs/migration/liveOverload/sub-07-cleanup-and-test-harness.md`](../liveOverload/sub-07-cleanup-and-test-harness.md).

## Purpose

Final hardening pass before the download manager rework ships:

1. **Contract parity audit** (Doc vs. Code) for sub-01 … sub-07.
2. **Cross-source test matrix** — make sure the contract holds uniformly across `github_k2_fsa`, `github_xdcobra`, `huggingface`, and a synthetic custom source.
3. **Example app integration** — wire a source picker into the download showcase so users can A/B compare GitHub and Hugging Face.
4. **Documentation closure** — rewrite `docs/download-manager.md` around the new source-aware API. Add per-source examples (k2-fsa, XDcobra, Hugging Face, custom server). Document the error code table.
5. **Native build verification** — Android + iOS compile clean; example smoke-tests pass on both platforms.

After this phase, the rework is **release-ready**.

---

## Workstream 1 — Contract parity audit

For each requirement in sub-01 through sub-07, mark **Implemented**, **Partially implemented**, or **Missing**; attach concrete code references; classify as `must-fix-before-release` or `acceptable-deviation` (with rationale).

Audit checklist anchored to the overview's "Definition of done":

- [ ] **Overview §"SOLL-Zustand" row 1 — Source selection pluggable.**
  - Spot-check: `getDefaultSourceForCategory(ModelCategory.Tts) === 'github_k2_fsa'`, `getDefaultSourceForCategory(ModelCategory.Alignment) === 'github_xdcobra'`.
  - Spot-check: `setDefaultSourceForCategory(ModelCategory.Stt, 'huggingface')` survives across `ensureBuiltinSourcesRegistered()` calls.
- [ ] **Overview §"SOLL-Zustand" row 6 — Retry off by default.**
  - `rg retryWithBackoff src/` returns empty.
  - `rg 'maxRetries' src/download/` matches only the option type alias, not a default-value site.
- [ ] **Overview §"Cross-source error contract" — every `DOWNLOAD_*` code is produced by at least one code path and consumed by at least one test.**
  - Implement a simple `rg`-based audit script in `__tests__/errorCodeAudit.test.ts` that grep-checks the codes are referenced.
- [ ] **Sub-04 — `archiveExt` removed; no caller references it.**
  - `rg "archiveExt" src/` returns empty.
- [ ] **Sub-04 — `SUPPORTED_ARCHIVE_FORMATS` matches native + build-script reality.**
  - `formats.parity.test.ts` (drift guard from sub-04) is green.
  - Manually re-read `android/src/main/cpp/jni/archive/sherpa-onnx-archive-helper.cpp`, `ios/archive/sherpa-onnx-archive-helper.mm`, `third_party/libarchive_prebuilt/build_libarchive_android.sh`, `third_party/libarchive_prebuilt/build_libarchive_ios.sh` and confirm the constant lists exactly the intersection (filters registered by the helper × decoders enabled in both build scripts).
- [ ] **Sub-04 — Archive-as-root invariant: `SherpaOnnx.extractArchive` has exactly one JS call site.**
  - `rg "extractArchive" src/download/` shows a single hit in `commitModel` (sub-06's renamed `runPostDownloadProcessing`).
  - `rg "extractArchive" src/extraction/` shows the native bridge wrapper only.
  - Cross-source test `X-9` (below) proves no folder-layout asset triggers extraction even when its `relativePath` ends in an archive extension.
- [ ] **Sub-05 — `huggingface` provider registered; HF source config helpers exported.**
- [ ] **Sub-06 — temp dir invariant. No `tempDir` survives a successful run.**
  - Filesystem assertion in `multiAsset.test.ts` (existing) + manual smoke.
- [ ] **Sub-07 — Per-source disk subtree.**
  - On-device `tree models/` shows `<sourceId>/<category>/<modelId>/`.

The audit lives in this sub-plan as a markdown table once executed (rather than as a separate file) since the rework surface is small enough to track inline.

---

## Workstream 2 — Cross-source test matrix (Jest)

A focused set of cross-source tests verifies uniform contract behaviour beyond the per-sub-plan suites. Co-located in `src/download/__tests__/crossSource.test.ts`.

| # | Test | What it verifies |
|---|---|---|
| X-1 | **Error code parity**: trigger `DOWNLOAD_HTTP_STATUS` via mock `sourceFetch` failure for `github_k2_fsa`, `github_xdcobra`, `huggingface`, and a registered custom provider. Assert all four throw `DownloadError` with `code === 'DOWNLOAD_HTTP_STATUS'` and the right `source` field. | One error code, one shape, no per-source string drift. |
| X-2 | **Header propagation parity**: `configureSource(s, { token: 'tok' })` for each source; assert outgoing `Authorization: Bearer tok` in the mocked fetch. | Header merge logic is source-agnostic. |
| X-3 | **`ensureModel` parity**: each source with a mocked happy-path provider + mocked BG downloader; assert `ready.localPath` resolves under `<base>/sherpa-onnx/models/<sourceId>/...`. | Disk layout is source-aware. |
| X-4 | **`pauseDownload` / `resumeDownload` parity**: archive happy path (`github_k2_fsa`) + folder happy path (`huggingface`) — pause mid-fetch, assert temp dir kept, resume, assert commit. | Pause/resume works across layouts. |
| X-5 | **`deleteIncompleteDownload` parity**: cancel mid-fetch for both layouts; assert temp dir removed. | Cleanup parity. |
| X-6 | **Default routing**: invoke each public API without `source`. Verify they hit `getDefaultSourceForCategory`. | Backward compatibility of default callers. |
| X-7 | **Custom source happy path**: register a tiny `{ id: 'custom_mirror', listModels, defaultHeaders }` provider, configure with `{ headers: { 'X-Mirror-Key': 'k' } }`, run `ensureModel`. Verify the model ends up at `models/custom_mirror/...`. | Custom sources are first-class. |
| X-8 | **Format gate**: register a custom provider returning `format: 'zip'`. `downloadModel` for that model throws `DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT` synchronously. | Format gate fires at planning time. |
| X-9 | **Archive-as-root invariant cross-source**: register a custom folder-layout provider returning `assets: [{ relativePath: 'model.onnx' }, { relativePath: 'weights/legacy.tar.bz2' }]`. Spy on `SherpaOnnx.extractArchive`. Run `ensureModel` end-to-end. | Both files committed under `models/<sourceId>/<category>/<id>/`; the `.tar.bz2` lives on disk as a plain file; `extractArchive` spy is invoked **zero** times. Repeat with `huggingface` provider mocked to return the same shape — same assertion holds. |

These tests are kept lean — they verify **uniformity**, not source-specific behaviour (already covered by sub-02 / sub-05 suites).

### Jest/tooling stability

- [ ] If required suites fail due to runner/config/tooling issues (ESM transform, transitive `react-native-*` imports, etc.), classify as `must-fix-before-release` in the audit. Do not drop suites.
- [ ] Keep one canonical reproducible command set (local + CI) for the per-source suites + the cross-source matrix.

---

## Workstream 3 — Example app integration

The example app already has a download showcase at `example/src/screens/download-showcase/DownloadShowcaseScreen.tsx`. Extend it with:

1. **Source picker** next to the existing category picker. Lists sources where `provider.supportsCategory(selectedCategory) === true`. The default-selected source is `getDefaultSourceForCategory(selectedCategory)`.
2. **Header / token field** (collapsed by default) that lets the tester paste a HF or GitHub token and apply it via `configureSource(sourceId, { token })`.
3. **Per-source "switch default" toggle**: writes `setDefaultSourceForCategory(category, sourceId)` so subsequent default-source calls go elsewhere.
4. **Result of `getModelsCacheStatus(category, { source })`** displayed below the picker (timestamp + source label).

UI affordances:

- Keep the surrounding download/pause/resume controls identical so the rest of the screen is unchanged.
- The currently-downloaded list at the bottom is grouped by source.
- The download progress bar reads `Progress.percent` straight from the existing `onProgress(category, modelId, progress)` callback — no app-side change needed for progress aggregation (sub-06 keeps the public shape).

A small smoke checklist for the showcase:

- [ ] Download `sherpa-onnx-whisper-tiny` (or another small STT model) from `github_k2_fsa` (default) — works as today.
- [ ] Configure `huggingface` with a curated repo + token if private. Switch the picker to `huggingface`. Refresh, download, see the multi-file commit succeed.
- [ ] Switch back to `github_k2_fsa`. The previously downloaded `huggingface` install is still visible in the per-source group.
- [ ] Use `purgeAll()` (existing button) and confirm both source subtrees are wiped.

---

## Workstream 4 — Documentation closure

Rewrite `docs/download-manager.md` so each section reflects the source-aware API. Use the existing structure (Introduction, Peer dependency, Model ids, Quick start, Setup, API reference, Types) but rewrite as follows:

- **Quick start §1** ("One call: ensure model is ready"): keep today's example, with one sentence after the snippet noting `ensureModel(..., { source })` is the way to switch sources.
- **Quick start §2** add a new "Switch source per category" block:
  ```ts
  import { setDefaultSourceForCategory, configureSource, BUILTIN_SOURCE_IDS } from 'react-native-sherpa-onnx/download';

  configureSource(BUILTIN_SOURCE_IDS.HUGGINGFACE, {
    token: process.env.HF_TOKEN,
  });
  setDefaultSourceForCategory(ModelCategory.Stt, BUILTIN_SOURCE_IDS.HUGGINGFACE);

  // …Subsequent ensureModel(...) calls without { source } now hit Hugging Face.
  ```
- **Quick start §3** add a "Register a custom source" example with a 20-line `SourceProvider` implementation that talks to a self-hosted mirror.
- **Setup** add a "Headers and tokens" subsection explaining `configureSource(sourceId, { headers, token, tokenScheme })` and the merge order from sub-03.
- **API reference**: every function gets a new optional `{ source }` field on its options type. New functions documented: `registerSource`, `unregisterSource`, `getSource`, `tryGetSource`, `listSources`, `listBuiltinSources`, `configureSource`, `getSourceConfig`, `setDefaultSourceForCategory`, `getDefaultSourceForCategory`, `sourceFetch`, `configureHuggingFaceSource`.
- **Types and constants**: `SourceProvider`, `SourceModel`, `SourceAssetEntry`, `SourceAssetLayout`, `SourceArchiveFormat`, `SourceFetchContext`, `RequestPolicy`, `DownloadError`, `DownloadErrorCode`, `BUILTIN_SOURCE_IDS` table.
- **Error codes table**: replace today's `Error type/code` table with the full `DOWNLOAD_*` set.
- **Troubleshooting**: add rows for the new codes.

A short "Migration from <pre-rework>" section at the bottom describes:

- `ModelMeta.archiveExt` → `ModelMeta.layout`.
- `ModelMeta.downloadUrl` → `ModelMeta.assets[0].url` (archive) or fan-out (folder).
- `RELEASE_API_BASE` / `releaseApiBase` overrides gone.
- New `{ source }` option throughout.

---

## Workstream 5 — CHANGELOG

Add an `[Unreleased]` block with a single breaking entry:

> ### Breaking
> - **Download manager rework.** `react-native-sherpa-onnx/download` is now source-aware. `ModelMeta.archiveExt` and `ModelMeta.downloadUrl` are replaced by `ModelMeta.layout` + `ModelMeta.assets[]`. The new `SourceProvider` abstraction adds first-class Hugging Face support and per-source headers/tokens. The internal `retryWithBackoff` helper is removed; retries are now opt-in via `requestPolicy`. See [`docs/download-manager.md`](docs/download-manager.md) for the new API and migration notes.

---

## Workstream 6 — Native build verification

- [ ] `yarn` install clean.
- [ ] `cd example/ios && pod install` clean.
- [ ] `yarn ios` builds and launches.
- [ ] `yarn android` builds and launches.
- [ ] Showcase screen smoke checklist (above) passes on both platforms.

---

## Acceptance criteria

- All sub-plan acceptance items from sub-01 through sub-07 are checked off and reconciled.
- The cross-source Jest matrix (X-1 … X-8) is green.
- `docs/download-manager.md` reflects the source-aware API; every public function has at least one example.
- The example showcase renders the source picker and downloads from at least two sources end-to-end.
- CHANGELOG entry merged.
- CI green on Android + iOS.
- No legacy paths or types survive in the codebase (`archiveExt`, `downloadUrl`, `RELEASE_API_BASE`, `retryWithBackoff` — none of these strings appear in `src/`).
- IST/SOLL review (whole-feature): every row in the overview's "SOLL-Zustand" table maps to a concrete code reference; the audit table records the references.

---

## Resolved decisions

### OQ-8.1 — Should we ship a CLI helper for ` SourceProvider` authors?

**Decision: No (deferred; not in scope).**

`sourceFetch` + the TypeScript contract are enough. Tooling can be added later if external custom-source authors ask for it.

### OQ-8.2 — Should we mirror the showcase as a separate `source-showcase` screen?

**Decision: No — extend the existing showcase (accepted).**

The existing screen is the de facto integration test. Splitting screens doubles the maintenance footprint without unique value.

### OQ-8.3 — Should the example app ship a default HF token?

**Decision: No (accepted).**

Public examples never ship tokens. The showcase exposes a UI field for ad-hoc testing.
