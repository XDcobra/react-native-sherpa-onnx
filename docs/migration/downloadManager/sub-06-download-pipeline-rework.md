# Sub-Plan 06: Multi-Asset Download Engine, Cancellation & Atomic Readiness

## Status
- Phase: **6**
- Depends on: sub-01 (contract), sub-02 (source registry), sub-03 (fetcher), sub-04 (layout), sub-05 (HF folder layout — the first real consumer).
- Prerequisite for: sub-07 (registry/paths source-namespacing), sub-08 (docs + example app).

## Cross-references
- Overview: [`download_manager_overview.md`](./download_manager_overview.md)
- Existing engine: `src/download/downloadTask.ts` (`downloadModelOnce`, `trackDownloadTask`, `cleanupCanceledDownload`).
- Existing extraction module: `src/download/modelExtraction.ts`, `src/download/postDownloadProcessing.ts`.
- Existing background downloader contract: `src/download/background-downloader-types.ts`.
- Existing ensure flow: `src/download/ensureModel.ts`.

## Purpose

Take the current single-asset engine (one archive **or** one ONNX file per model) and turn it into a **multi-asset, atomic-readiness** engine that:

1. Iterates `ModelMeta.assets[]` (1 entry for `kind: 'archive'`, N for `kind: 'folder'`).
2. Downloads each asset into a **per-model temp folder**, never the final folder.
3. Aggregates per-asset progress into one `Progress` event stream (existing event shape stays).
4. **Atomically commits** the temp folder to its final location after **all** assets are present and (when applicable) extraction succeeded.
5. On cancel / error / pause, cleans up the temp folder leaving no half-installed model.
6. Preserves pause/resume semantics for both archive layout (today's behaviour) and folder layout (new).

This sub-plan also **removes the implicit `maxRetries: 2` loop** introduced in `downloadModel` today (sub-03 partially started this; sub-06 finishes by deleting it). Retries on transfer-level failures are sub-03's `requestPolicy` opt-in.

---

## Design principles

1. **Atomicity via `.tmp` rename.** Every model is downloaded into `<modelDir>.tmp-<uuid>/` and **moved** to `<modelDir>/` only after success. If anything fails or is cancelled, the temp folder is unlinked.
2. **One asset = one BackgroundDownloader task.** We don't multiplex assets through a single task (the native downloader doesn't support that anyway). Tasks are id'd as `<sourceId>:<category>:<modelId>:<assetIdx>` so the existing `activeDownloadTasks` map stays trivially keyed.
3. **Asset ordering is provider-defined.** The engine downloads assets in the order returned by `model.assets[]`. Providers therefore control which file appears first in the progress stream (useful for "show the manifest first" UIs).
4. **Progress aggregation is bytes-based.** `aggregatePercent = (sumBytesProcessed / sumTotalBytes) * 100`. Per-asset progress is **not** exposed in the public stream (Progress shape is unchanged for SDK consumers); the showcase screen can read individual files via a future internal extension if needed.
5. **Pause is asset-aware, resume is asset-aware.** Today's `.download-state-<id>.json` becomes a richer document (`assets: [{ relativePath, bytesDownloaded }]`). Resume picks up the first asset that isn't complete.
6. **No retries at the engine level.** Transfer-level failures throw immediately. The caller's `requestPolicy.retries` (if any) takes effect at the *whole-model* granularity, not per-asset: the engine throws on first failure, and the *caller* may invoke `downloadModel` again.

---

## Files to modify

```
src/download/
  downloadTask.ts                // Rewrite: drive assets[] instead of one archive.
  modelExtraction.ts             // No changes beyond the layout dispatch from sub-04 (extraction
                                 //   is only invoked for archive+extract:true; folder commits
                                 //   skip extraction entirely).
  postDownloadProcessing.ts      // Becomes "commit phase": verify + checksum + manifest + ready
                                 //   marker. Knows about both layouts.
  ensureModel.ts                 // Uses the new `getIncompleteDownloads` shape (asset-aware).
  bulkPurge.ts                   // Knows how to wipe tempo folders too.
  localModels.ts                 // No code change; the resolved `getModelDir` already works.
  validation.ts                  // checkDiskSpace: pass model.bytes (sum across assets) — already
                                 //   the correct value.
  paths.ts                       // Add getTempModelDir + getDownloadStatePath:
                                 //   `.download-state-<modelId>.json` shape gains `assets[]`.
  __tests__/multiAsset.test.ts   // NEW
  __tests__/cleanup.test.ts      // NEW
```

---

## TypeScript / payload shapes

### `getTempModelDir`

```ts
// src/download/paths.ts
export function getTempModelDir(
  category: ModelCategory,
  modelId: string,
  tempToken: string
): string {
  return `${getModelsBaseDir(category)}/.tmp-${modelId}-${tempToken}`;
}
```

`tempToken` is a short uuid-like string generated per `downloadModelOnce` call. It's persisted into the download state so resume picks the same temp folder.

### Revised `DownloadStateFile`

```ts
// src/download/types.ts
export type DownloadStateFile = {
  modelId: string;
  category: ModelCategory;
  sourceId: string;            // set when sub-07 lands; in sub-06 may be `'__legacy__'`
  phase: 'downloading';
  startedAt: string;
  /** Random per-attempt token; matches the .tmp-… directory name. */
  tempToken: string;
  /** Resolved temp folder. */
  tempDir: string;
  /** Resolved final folder (post-commit destination). */
  finalDir: string;
  /** Snapshot of model metadata at attempt start. */
  model: ModelMeta;
  /** Per-asset progress as last persisted. */
  assets: Array<{
    relativePath: string;
    bytesDownloaded: number;
    /** Set after the asset's transfer completes. */
    completed: boolean;
  }>;
  /** Sum across assets; convenience for `getIncompleteDownloads`. */
  totalBytes?: number;
};
```

### Progress aggregation

```ts
// src/download/downloadTask.ts (excerpt)
function reportProgress(
  category: ModelCategory,
  modelId: string,
  perAsset: Map<string, { processed: number; total: number }>,
  onProgress: ((p: Progress) => void) | undefined
): void {
  let processed = 0;
  let total = 0;
  for (const v of perAsset.values()) {
    processed += v.processed;
    total += v.total;
  }
  const percent = total > 0 ? (processed / total) * 100 : 0;
  const progress: Progress = {
    bytesProcessed: processed,
    totalBytes: total,
    percent,
    phase: 'downloading',
  };
  onProgress?.(progress);
  emitDownloadProgress(category, modelId, progress);
}
```

The `'extracting'` / `'extracting_resume_skipping'` phases are still emitted by `postDownloadProcessing.ts` — only for archive-layout commits.

---

## Per-layout execution

### Archive layout

For `layout.kind === 'archive'` (single asset):

1. `tempDir = getTempModelDir(category, id, tempToken)`. `mkdir`.
2. Download `assets[0]` into `tempDir/<relativePath>` (e.g. `tempDir/sherpa-onnx-whisper-tiny.tar.bz2`).
3. Write/update `.download-state-<id>.json` with `assets[0].bytesDownloaded`.
4. On done, if `layout.extract === true`:
   - Run `extractTarBz2` / `extractTarZst` (`extractArchive` auto-detects) into `tempDir/__model__/` (a subfolder of the temp dir).
   - On extract success, **rename** `tempDir/__model__/` → `finalDir`.
   - **Delete** the archive (unless `deleteArchiveAfterExtract: false`).
   - **Remove** the (now empty) `tempDir`.
5. If `layout.extract === false`:
   - Move `tempDir/<relativePath>` → `finalDir/<relativePath>` (single-file commit).
   - Write manifest with `sizeOnDisk = <file size>`.
6. Commit step (after rename): write `manifest.json` + ready marker into `finalDir`. Emit `modelsListUpdated`.

### Folder layout

For `layout.kind === 'folder'`:

1. `tempDir = getTempModelDir(...)`. `mkdir`.
2. For each `asset` in `model.assets`:
   - `dest = tempDir/<asset.relativePath>` (create intermediate directories as needed).
   - Create a BG download task with id `<sourceId>:<category>:<modelId>:<assetIdx>`. Source-aware id ensures no clash with the archive layout's task id.
   - Track its progress in `perAsset[<relativePath>]`.
   - On completion: update state file; verify checksum (`asset.sha256` if present); on mismatch → `DOWNLOAD_INTEGRITY_CHECKSUM_MISMATCH`.
3. After **all** assets complete:
   - **Rename** `tempDir` → `finalDir` (atomic move; if the OS only supports cross-filesystem copy then a `mv -fT` style copy+delete is implemented in JS using `react-native-fs` `moveFile` first, then a recursive copy fallback if needed).
   - Write `manifest.json` and ready marker.
4. **No extraction step. Ever.** Per the archive-as-root invariant (sub-04 → "Archive-as-root invariant"), folder layouts are written byte-for-byte at their `relativePath` regardless of file extension. An asset whose name happens to be `…/foo.tar.bz2` is left as a plain file on disk; `extractArchive` is never invoked from this code path.

> The "validate model dir contains model-like files" check from today (`validateExtractedFiles`) is still run at commit time, regardless of layout. It guards against providers that returned an empty folder.

> **Engine-wide invariant (enforced by code review + the tests below):** `SherpaOnnx.extractArchive` is referenced from **exactly one** call site in `src/download/` after sub-06: the archive+extract:true branch of `commitModel`. Any other reference is a bug. The folder layout never falls back to extraction, even on a single-asset model that happens to be an archive — the provider is responsible for choosing `kind: 'archive'` if it wants extraction.

---

## Cancellation & cleanup

### Cancel paths

| Source | Behaviour |
|---|---|
| `opts.signal.aborted` before `downloadModelOnce` enters the loop | Reject with `AbortError`-named `DownloadError(code: 'DOWNLOAD_CANCELLED')`. No disk activity. |
| `opts.signal.abort()` while assets are mid-flight | Each per-asset task is stopped via `task.stop()`. All registered cleanups run. Final state: `tempDir` removed, no state file, no final dir. |
| `pauseDownload(category, id)` | Like today: cancels the active asset task but **keeps** the temp folder and state file. Future `resumeDownload` continues from the first incomplete asset. |
| `deleteIncompleteDownload(category, id)` | Stops the active task (if any), removes the temp folder, the state file, and any partial files. |

### Cleanup invariants (asserted by tests)

1. Successful commit → no `tempDir` on disk; `finalDir` and `manifest.json` and ready marker all present.
2. Mid-fetch cancel/error → no `finalDir`; `tempDir` removed; no ready marker; no manifest.
3. Pause → `finalDir` absent; `tempDir` present; state file present with partial `bytesDownloaded`.
4. Resume → `finalDir` absent until commit; state file updated; ready marker only at the very end.
5. **Crash recovery**: a stale `tempDir` without a matching state file is removed on the next `downloadModel`/`ensureModel`/`getIncompleteDownloads` call for the same `(category, id)`.

---

## Implementation steps

1. Replace `downloadModelOnce`'s body with the new asset-iterating logic:
   - Resolve `tempDir`, `finalDir`, `tempToken`.
   - Compute disk-space requirement (`model.bytes + bufferForExtraction(layout)`), call `checkDiskSpace`.
   - For each asset: create BG task; track promise; on per-task `done`, update state and `perAsset` aggregator.
   - On all-done: post-download commit (extract or move).
   - On any per-task error/abort: cancel siblings, run `cleanupCanceledDownload`, throw.
2. Replace `trackDownloadTask` with `trackAssetTask` (single asset). The Promise-resolving plumbing stays virtually the same; cleanup hooks all share `tempDir`.
3. Replace `cleanupCanceledDownload`:
   - Accept `{ tempDir, statePath }`.
   - `removeDirectoryRecursive(tempDir)`.
   - `removeIfExists(statePath)`.
   - Existing native-asset-mirror cleanup (`removeDirectoryRecursive(getNativeAssetExtractedModelDir(id))`) stays.
4. Rework `runPostDownloadProcessing` (now: `commitModel`):
   - Branch on `layout.kind` + `layout.extract` (per the table in sub-04).
   - Archive+extract: extraction happens in `tempDir/__model__/`, then the rename to `finalDir` is the atomic commit.
   - Archive+no-extract: `moveFile(tempDir/<filename>, finalDir/<filename>)`.
   - Folder: `moveFile(tempDir, finalDir)` (or copy+delete fallback).
5. Update `getIncompleteDownloads`:
   - Scan `.download-state-*.json` files.
   - Per-state file: list `assets[]` with the recorded `bytesDownloaded` + reconcile against the actual on-disk file size.
   - Discard stale entries whose `tempDir` doesn't exist (and remove the state file).
6. Update `resumeDownload`:
   - Read state file; if missing → fresh `downloadModel`.
   - If `tempDir` missing → discard state, fresh `downloadModel`.
   - Otherwise: pick the first incomplete asset, re-launch the BG task pointing at the same path (BG library supports resume by id; if not, restart that single asset).
7. Update `pauseDownload`:
   - Today scopes by `<category>:<id>`. New scoping uses prefix match `<sourceId>:<category>:<modelId>:` — pause all asset tasks for that model.
8. Update `deleteIncompleteDownload`:
   - Stop all asset tasks for the prefix.
   - Remove `tempDir`, state file. Remove `getNativeAssetExtractedModelDir(id)` mirror as today.
9. Update `bulkPurge.ts`: also scan and unlink any orphan `.tmp-*` folders under each `getModelsBaseDir(category)`.
10. Update `ensureModel.ts`:
    - Keep the **logical** flow: ready check → resume extraction (only for archive+extract:true) → resume download (archive or folder) → fresh download.
    - The "resume extraction" path is unchanged; "resume download" now covers both layouts.
11. Add tests for multi-asset happy path, multi-asset cancel mid-asset, multi-asset checksum mismatch, multi-asset pause+resume, archive+no-extract path, folder fan-out (3 files), stale `.tmp-*` recovery.
12. Update the example showcase (lightweight pass) to verify the progress events still drive the UI without app-side changes.
13. IST/SOLL review: smoke an end-to-end `ensureModel({ source: 'github_k2_fsa', ... })` for archive layout and an end-to-end `ensureModel({ source: 'huggingface', ... })` for folder layout.

---

## Test matrix (Jest)

### `multiAsset.test.ts`

| # | Scenario | Expected |
|---|---|---|
| 1 | Archive happy path (`sherpa-onnx-whisper-tiny`, `extract: true`) | Same final result as today; existing archive-related tests still pass. |
| 2 | Archive `extract: false` happy path | Archive file ends up under `finalDir/<filename>`; ready marker present; no extraction call. |
| 3 | Folder layout, 3 files, all succeed | All three files under `finalDir/<relativePath>`; ready marker; manifest carries `sizeOnDisk` = sum of file sizes. |
| 4 | Folder layout, second asset fails (network error) | All BG tasks stopped; `tempDir` removed; no state file; no `finalDir`; thrown `DOWNLOAD_NETWORK_FAILED`. |
| 5 | Folder layout, second asset checksum mismatch | `DOWNLOAD_INTEGRITY_CHECKSUM_MISMATCH`; cleanup as in #4. |
| 6 | Folder layout, AbortSignal aborts after first asset done | Cleanup; `DOWNLOAD_CANCELLED`. |
| 7 | Folder layout, `pauseDownload` after first asset done | First asset's file stays in `tempDir`; state file shows `assets[0].completed: true`, `assets[1].bytesDownloaded: 0`. |
| 8 | Following #7, `resumeDownload` | Resumes from `assets[1]`; commit happens after all assets are present. |
| 9 | Crash recovery: a stale `.tmp-<id>-<token>/` exists with no state file; call `ensureModel` for that id | Stale temp removed; fresh download proceeds. |
| 10 | Concurrent `downloadModel` invocations for the same id | Second call resolves to the in-flight Promise (existing `activeDownloadTasks` behaviour preserved by prefix-keyed lookup). |
| 11 | Archive happy path with `requestPolicy: { retries: 2 }` and one transient `sourceFetch` failure during pre-flight | First attempt fails; second succeeds; `attempt` counter visible in logs only. |
| 12 | Folder layout whose `assets[]` includes `weights/legacy.tar.bz2` alongside `model.onnx` and `tokens.txt` | All three files land at their `relativePath` under `finalDir`. `SherpaOnnx.extractArchive` is **not** invoked (spy/mock asserts zero calls). The `.tar.bz2` file is preserved as-is on disk. |
| 13 | Folder layout with a single asset whose `relativePath` is `model.tar.bz2` (provider declared `kind: 'folder'` despite the suffix) | File is committed at `finalDir/model.tar.bz2` as a plain file. **No** extraction. Ready marker written. The filename suffix has zero effect on extraction. |
| 14 | `commitModel` invoked with `layout.kind === 'folder'` while `SherpaOnnx.extractArchive` is mocked to throw if called | Commit succeeds; the throw assertion proves the extractor was never invoked. |

### `cleanup.test.ts`

| # | Scenario | Expected |
|---|---|---|
| 1 | After `deleteIncompleteDownload(category, id)` mid-fetch | `tempDir` absent; state file absent; native asset mirror absent. |
| 2 | After successful download | `tempDir` absent; `finalDir` present; manifest + ready marker present. |
| 3 | `bulkPurge.purgeAll()` removes any `.tmp-*` folders left behind. | Pass. |
| 4 | `deleteModel(category, id)` when both `finalDir` and a stray `.tmp-*` exist | Both removed. |

---

## Acceptance criteria

- All test-matrix entries pass.
- The placeholder `DOWNLOAD_INVALID_LAYOUT` for folder layouts (introduced in sub-04) is **removed** from `downloadTask.ts` / `modelExtraction.ts`. Folder fan-out is a real code path.
- `cleanupCanceledDownload` no longer takes `(category, id, isArchive, downloadPath, modelDir, statePath)` — it takes `(tempDir, statePath)`. Audit confirms no caller passes the old shape.
- `getIncompleteDownloads` returns the new asset-aware shape (described in `DownloadStateFile`); the example showcase reads new fields without crashing.
- `downloadModel`'s outer `while (true) { try { … } catch { …attempt++… } }` loop is **deleted**. The only retry path is the caller's `requestPolicy`.
- No `tempDir` survives a clean run; no `finalDir` exists for a cancelled/failed run.
- IST/SOLL review: per archive AND folder smokes (see step 13).

---

## Resolved decisions

### OQ-6.1 — Should multi-asset downloads run in parallel?

**Decision: Serial (accepted).**

Background downloader bandwidth on mobile is the bottleneck; parallel tasks would compete and hurt aggregate progress UX. Serial keeps the progress stream smooth and resume logic trivially ordered.

### OQ-6.2 — Atomic rename across filesystems on Android?

**Decision: `moveFile` then fall back to recursive copy + delete (accepted).**

`react-native-fs` `moveFile` works within the same filesystem; on rare cross-FS moves (host-app sandboxed storage redirection), the engine falls back to a recursive copy followed by `unlink(tempDir)`. The fallback is itself written defensively (each-file try/catch); a failed copy leaves the partial final dir which is cleaned up by the **next** `ensureModel` call (which finds no ready marker and re-downloads, or by `purgeAll`).

### OQ-6.3 — Should checksums be verified per-asset (folder) or only at commit time?

**Decision: Per-asset, immediately after fetch (accepted).**

Catching a corrupt asset early avoids wasting bandwidth on subsequent assets that would be discarded on commit-time fail. Verification reuses the existing `validateChecksum` helper.

### OQ-6.4 — Resume granularity: bytes inside an asset, or asset-level only?

**Decision: Asset-level only (accepted).**

The background downloader handles intra-asset byte resume natively (HTTP Range / its own state). The engine only tracks which assets have completed; mid-asset resume is the BG library's job.

### OQ-6.5 — Disk-space buffer for folder layouts?

**Decision: 20% headroom over `model.bytes` (matches today's archive buffer).**

`validation.checkDiskSpace` already adds 20%; folder layouts inherit the same.
