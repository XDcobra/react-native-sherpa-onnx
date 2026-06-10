# Sub-Plan 04: Archive Layout, Format Gates & Extraction Flags

## Status
- Phase: **4**
- Depends on: sub-01 (`SourceAssetLayout`, `SourceArchiveFormat`), sub-02 (built-in providers), sub-03 (fetcher).
- Prerequisite for: sub-05 (Hugging Face folder layout), sub-06 (download engine), sub-07 (registry / paths).

## Cross-references
- Overview: [`download_manager_overview.md`](./download_manager_overview.md)
- Existing extraction module: `src/extraction/` (`extractTarBz2.ts`, `index.ts`, `types.ts`).
- Existing model meta: `src/download/types.ts` (`ModelMeta.archiveExt`, `ModelArchiveExt`).
- Existing post-download fan-out: `src/download/postDownloadProcessing.ts`.
- **Native runtime contract (the source of truth for which archive formats are accepted at all):**
  - `android/src/main/cpp/jni/archive/sherpa-onnx-archive-helper.cpp` — function `ConfigureArchiveFormats(struct archive* a)`.
  - `ios/archive/sherpa-onnx-archive-helper.mm` — function `ConfigureArchiveFormats(struct archive* a)`.
- **Compile-time contract (the source of truth for which filters are actually linked into the prebuilt libarchive shipped with the SDK):**
  - `third_party/libarchive_prebuilt/build_libarchive_android.sh`.
  - `third_party/libarchive_prebuilt/build_libarchive_ios.sh`.

## Purpose

Generalize the **two implicit layouts** of today's pipeline (single `tar.bz2` archive, single `.onnx` blob) into a first-class **`SourceAssetLayout`** that:

1. Is set by the provider per `SourceModel` (sub-01).
2. Survives unchanged into `ModelMeta` so cache + paths + post-download can dispatch on it.
3. Reaches the native extractor through a **format-aware** path: every format in `SUPPORTED_ARCHIVE_FORMATS` (read from the native helper + build scripts — see [Supported formats](#supported-formats-source-of-truth)) is accepted; every other `format` is rejected at planning time with `DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT`.
4. Honors `extract: false` (download-only — archive sits on disk, ready marker is still written so the model is "ready", but no unpack happens).
5. Enforces the **archive-as-root invariant**: a model is *unpacked* if and only if its sole asset **is** the archive that contains the model root. Folder-layout models never trigger extraction, even if one of their assets happens to be a `.tar.bz2` inside a nested directory (see [Archive-as-root invariant](#archive-as-root-invariant)).

This sub-plan does **not** introduce multi-asset fan-out — that's sub-06. It only opens up the *shape* + the *gates* so sub-06 can fan out to N assets and sub-05 can describe Hugging Face's folder layout.

---

## Design principles

1. **Single source of truth for "what shape is this?"** `SourceModel.layout` → `ModelMeta.layout`. No string sniffing of filenames anywhere downstream. The fact that an asset's `relativePath` ends in `.tar.bz2` is **never** sufficient reason to extract it — only `layout.kind === 'archive' && layout.extract === true` triggers extraction (see [Archive-as-root invariant](#archive-as-root-invariant)).
2. **Format gate is enforced at plan time.** Before the first byte is downloaded, the engine checks `layout.format ∈ SUPPORTED_ARCHIVE_FORMATS`. Unsupported formats throw `DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT` synchronously from `downloadModel` / `ensureModel` / `extractModel`.
3. **`extract: false` is meaningful.** Archive layout with `extract: false` means: download the archive into `getModelDir(category, id)/<filename>`, **do not** run `extractArchive`, write the ready marker. The model's "files" are then the raw archive — the consumer of the SDK opens it themselves (e.g. a third-party tool wants the raw asset).
4. **Folder layout never extracts.** Provider authors who emit `kind: 'folder'` cannot accidentally request extraction. The type system enforces `extract: false`. The download engine never invokes `extractArchive` on a folder-layout asset, regardless of file extension.
5. **Native capabilities advertised by JS-side constant.** `SUPPORTED_ARCHIVE_FORMATS` is the **intersection** of formats registered by the native helper (`ConfigureArchiveFormats`) and formats whose decoder is enabled by both libarchive build scripts (`build_libarchive_android.sh`, `build_libarchive_ios.sh`). Extending native libarchive support is a deliberate, paired change: native helper + both build scripts + `SourceArchiveFormat` union + this constant + format-gate tests.

---

## Supported formats (source of truth)

The JS-side `SUPPORTED_ARCHIVE_FORMATS` constant **must mirror** the formats that are simultaneously:

1. **Registered** by the native helper's `ConfigureArchiveFormats(struct archive* a)`:
   - `android/src/main/cpp/jni/archive/sherpa-onnx-archive-helper.cpp`
   - `ios/archive/sherpa-onnx-archive-helper.mm`

   At the time this sub-plan was written the helper registers the POSIX `tar` format plus four filters:

   ```cpp
   archive_read_support_format_tar(a);
   archive_read_support_filter_bzip2(a);
   archive_read_support_filter_gzip(a);
   archive_read_support_filter_xz(a);
   archive_read_support_filter_zstd(a);
   ```

2. **Linked into the prebuilt libarchive shipped by the SDK**, governed by the CMake flags in:
   - `third_party/libarchive_prebuilt/build_libarchive_android.sh` — currently `ENABLE_ZSTD=ON`, `ENABLE_BZip2`, `ENABLE_LZMA`, `ENABLE_LZ4`, `ENABLE_LZO` per the script (revisit the script before changing this table).
   - `third_party/libarchive_prebuilt/build_libarchive_ios.sh` — currently `ENABLE_ZSTD=ON`, `ENABLE_BZip2=ON`, `ENABLE_LZMA=OFF`, `ENABLE_LZ4=OFF`.

The resulting `SourceArchiveFormat` union and `SUPPORTED_ARCHIVE_FORMATS` constant must therefore enumerate **exactly** the formats that satisfy both criteria at implementation time, and nothing more. The recommended implementation procedure:

> Before implementing this sub-plan, re-read both build scripts and the native helper. Build a table of "registered in helper" × "enabled in Android build" × "enabled in iOS build". Take the intersection. That intersection is `SUPPORTED_ARCHIVE_FORMATS`. Do **not** add a format whose decoder is disabled in either build script — even if the helper registers it — because the prebuilt would fail at runtime.

If the table at implementation time matches the four filters listed above on both platforms, `SUPPORTED_ARCHIVE_FORMATS` is:

```ts
export const SUPPORTED_ARCHIVE_FORMATS: readonly SourceArchiveFormat[] = [
  'tar.bz2',
  'tar.gz',
  'tar.xz',
  'tar.zst',
] as const;
```

If a filter is disabled in one of the build scripts, it must be removed from `SUPPORTED_ARCHIVE_FORMATS` here (and from the `SourceArchiveFormat` union in sub-01). The Jest test `formats.parity.test.ts` (see [Test matrix](#test-matrix-jest)) reads both helper files and both build scripts and asserts the constant matches the intersection — drift fails CI.

---

## Archive-as-root invariant

A core invariant of the rework is:

> **Extraction happens if and only if the model's *only* asset *is* the archive that contains the model root.**

In other words:

- A `kind: 'archive'` model has **exactly one** asset. That asset **is** the archive. Extracting it produces the model directory.
- A `kind: 'folder'` model has **N ≥ 1** assets. Each asset is materialised at its `relativePath` under the final model directory. **No** asset is ever interpreted as an archive, even if its `relativePath` ends in `.tar.bz2`, `.tar.zst`, `.tar.gz`, or `.tar.xz`. The asset is downloaded byte-for-byte and committed as-is.

Concretely:

| Scenario | Layout the provider must emit | Extraction behaviour |
|---|---|---|
| GitHub k2-fsa release: `sherpa-onnx-whisper-tiny.tar.bz2` | `{ kind: 'archive', format: 'tar.bz2', extract: true }`, single asset whose `relativePath` is the archive filename. | Extracted into `getModelDir(...)`. |
| GitHub release of a single `.onnx` (e.g. `silero_vad.onnx`) | `{ kind: 'folder', format: 'none', extract: false }`, single asset whose `relativePath` is `silero_vad.onnx`. | Placed at `getModelDir(...)/silero_vad.onnx`. **Not** extracted. |
| Hugging Face model where `siblings` includes `model.onnx`, `tokens.txt`, and `weights/legacy.tar.bz2` (an archived sub-asset the upstream repo happens to bundle as-is) | `{ kind: 'folder', format: 'none', extract: false }`, three assets with their actual `relativePath`s. | All three placed under `getModelDir(...)` at their `relativePath`. The `weights/legacy.tar.bz2` is **not** unpacked — extraction is gated on `layout.kind`, never on filename. The model consumes the archive file as data. |
| Custom mirror that ships a `model.tar.bz2` *inside* a folder of other files | The provider must choose: either emit `{ kind: 'archive', extract: true }` (with the archive as the model root — additional files outside the archive cannot be served by the same `SourceModel`) **or** `{ kind: 'folder', extract: false }` (no extraction; the archive lives on disk as a plain file). | One or the other; never both at once. |

This is enforced by the runtime guards:

- The download engine (sub-06) never invokes `extractArchive` for a `kind: 'folder'` asset. It writes the bytes to `getAssetDestPath(...)` and moves on.
- The format gate `assertSupportedLayout` only inspects `layout.format` when `layout.kind === 'archive'`. For `kind: 'folder'`, the format field is fixed to the structural sentinel `'none'`; the gate is a no-op.
- The `assertValidLayoutAssets` guard rejects `kind: 'archive'` with `assets.length !== 1` (an archive layout cannot bundle "the archive plus other files"). Providers wanting a richer install should use `kind: 'folder'`.

### Sequencing in the download engine

1. **Plan**: resolve `model.layout` from the provider's `SourceModel`. Call `assertSupportedLayout` and `assertValidLayoutAssets`. Both gates fail fast with `DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT` or `DOWNLOAD_INVALID_LAYOUT` respectively.
2. **Fetch**: download `model.assets[]` per [Pipeline behaviour per layout](#pipeline-behaviour-per-layout). At this point no extraction decision is made based on filename.
3. **Commit**: in `commitModel` (sub-06's renamed `runPostDownloadProcessing`), dispatch **only on `layout.kind` and `layout.extract`**:
   - `kind === 'archive' && extract === true` → exactly one `extractArchive` call on `assets[0]`, target = the temp model root.
   - everything else → no `extractArchive` call ever.

The native bridge (`SherpaOnnx.extractArchive`) is **not** invoked from any code path other than this branch. There is no fallback "if the file ends in .tar.bz2 try to extract it"; the only signal is `layout`.

---

## Files to add / modify

```
src/download/
  types.ts                       // ModelMeta:
                                 //   - REMOVE: archiveExt: 'tar.bz2' | 'onnx'
                                 //   - ADD:    layout: SourceAssetLayout
                                 //             assets: Array<{ relativePath, bytes?, sha256? }>
                                 //             sourceId: string  (also set by sub-07; field is reserved here)
                                 // ExtractionState / DownloadStateFile: track `layout` (replace
                                 //   today's implicit boolean `isArchive`).
                                 // ModelArchiveExt: REMOVED (replaced by SourceArchiveFormat).
  paths.ts                       // getArchivePath / getTarArchivePath / getOnnxPath revised to
                                 //   take a layout, not an archiveExt. New helper:
                                 //   getAssetDestPath(category, modelId, relativePath) for folder
                                 //   layouts.
  downloadTask.ts                // Replace `model.archiveExt === 'tar.bz2'` checks with
                                 //   `model.layout.kind === 'archive'`. Plan-time format gate.
  modelExtraction.ts             // Same; reject extraction for non-archive layouts upfront.
  postDownloadProcessing.ts      // Dispatch on layout: archive+extract:true → extract; archive+
                                 //   extract:false → no-op; folder → no-op (fan-out happens at the
                                 //   download engine in sub-06).
  ensureModel.ts                 // Replace `isArchive = model.archiveExt === 'tar.bz2'` →
                                 //   `isArchive = model.layout.kind === 'archive' && model.layout.extract`
                                 //   and route accordingly.
  sources/
    formats.ts                   // SUPPORTED_ARCHIVE_FORMATS constant, assertSupportedFormat helper.
    __tests__/formats.test.ts

src/extraction/
  extractTarBz2.ts               // Filename only — already format-agnostic native-side. No code
                                 //   change beyond a parameter rename pass: `archiveFormat` log line.
  index.ts                       // extractArchive(BundledArchive, ...) is format-agnostic native-side;
                                 //   add explicit doc that the JS layer's format gate (this sub-plan)
                                 //   restricts the JS surface to SUPPORTED_ARCHIVE_FORMATS only.
```

---

## TypeScript changes

### `ModelMeta`

**Today:**

```ts
// src/download/types.ts
export type ModelArchiveExt = 'tar.bz2' | 'onnx';
export type ModelMeta = {
  id: string;
  displayName: string;
  downloadUrl: string;
  archiveExt: ModelArchiveExt;
  bytes: number;
  sha256?: string;
  category: ModelCategory;
  // …
};
```

**Target:**

```ts
// src/download/types.ts
import type {
  SourceAssetEntry,
  SourceAssetLayout,
} from './sources/types';

export type ModelMeta = {
  id: string;
  displayName: string;
  category: ModelCategory;

  /** Replaces today's `archiveExt` field. */
  layout: SourceAssetLayout;
  /** One entry for archive layout; >= 1 for folder layout. */
  assets: SourceAssetEntry[];
  /** Sum of `assets[].bytes`. */
  bytes: number;

  /**
   * Source id; reserved here, populated by sub-07's registry rework.
   * Optional in this phase to keep sub-02 tests green during the transition.
   */
  sourceId?: string;

  /** Convenience: top-level sha256 only when `layout.kind === 'archive'`. */
  sha256?: string;

  modelType?: string;
  languages?: string[];
  quantization?: Quantization;
  sizeTier?: SizeTier;
  isStreaming?: boolean;
  supportsQnn?: boolean;
  isHardwareSpecificUnsupported?: boolean;
};
```

The legacy `archiveExt` field is **removed** (clean cut). Existing tests that destructure `model.archiveExt` are updated as part of this sub-plan.

### `downloadUrl` removed

Today, `ModelMeta.downloadUrl` is a single URL. After sub-04, the URL lives on `assets[]`. Code that read `model.downloadUrl` is updated to read `model.assets[0].url` for archive layouts.

### `formats.ts`

```ts
// src/download/sources/formats.ts
import type { SourceArchiveFormat } from './types';
import { DownloadError } from './errors';

/**
 * Archive formats accepted by `extractArchive`. MUST match the intersection of:
 *   - filters registered by ConfigureArchiveFormats(...) in
 *     android/src/main/cpp/jni/archive/sherpa-onnx-archive-helper.cpp
 *     and ios/archive/sherpa-onnx-archive-helper.mm
 *   - decoders enabled by both libarchive build scripts in
 *     third_party/libarchive_prebuilt/.
 *
 * See sub-04 → "Supported formats (source of truth)" before changing this list.
 * The parity test `formats.parity.test.ts` enforces the match at CI time.
 */
export const SUPPORTED_ARCHIVE_FORMATS: readonly SourceArchiveFormat[] = [
  'tar.bz2',
  'tar.gz',
  'tar.xz',
  'tar.zst',
] as const;

export function isSupportedArchiveFormat(
  format: string
): format is SourceArchiveFormat {
  return (SUPPORTED_ARCHIVE_FORMATS as readonly string[]).includes(format);
}

export function assertSupportedLayout(opts: {
  layout:
    | { kind: 'archive'; format: string; extract: boolean }
    | { kind: 'folder'; format: 'none'; extract: false };
  source?: string;
  category?: string;
  modelId?: string;
}): void {
  const { layout } = opts;
  // Folder layouts never run extraction → format is the structural sentinel
  // 'none' and the format gate is a no-op. This is the JS-side mirror of the
  // archive-as-root invariant described in sub-04.
  if (layout.kind !== 'archive') return;

  if (!isSupportedArchiveFormat(layout.format)) {
    throw new DownloadError(
      'DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT',
      `archive format "${layout.format}" is not supported (allowed: ${SUPPORTED_ARCHIVE_FORMATS.join(', ')})`,
      {
        source: opts.source,
        category: opts.category,
        modelId: opts.modelId,
      }
    );
  }
}

export function assertValidLayoutAssets(model: {
  layout: { kind: 'archive' | 'folder' };
  assets: Array<{ relativePath: string }>;
}): void {
  if (model.layout.kind === 'archive' && model.assets.length !== 1) {
    throw new DownloadError(
      'DOWNLOAD_INVALID_LAYOUT',
      `archive layout requires exactly one asset, received ${model.assets.length}`
    );
  }
  if (model.assets.length === 0) {
    throw new DownloadError(
      'DOWNLOAD_INVALID_LAYOUT',
      'layout must declare at least one asset'
    );
  }
  for (const a of model.assets) {
    if (
      typeof a.relativePath !== 'string' ||
      a.relativePath.length === 0 ||
      a.relativePath.startsWith('/') ||
      a.relativePath.includes('..') ||
      a.relativePath.includes('//')
    ) {
      throw new DownloadError(
        'DOWNLOAD_INVALID_LAYOUT',
        `invalid relativePath "${a.relativePath}"`
      );
    }
  }
}
```

### Paths rework

```ts
// src/download/paths.ts (relevant deltas)

export function getModelDir(category: ModelCategory, modelId: string): string {
  // Source-aware namespacing is deferred to sub-07; for now this stays as-is.
  return `${getModelsBaseDir(category)}/${modelId}`;
}

/** Archive layouts only: the single archive's path on disk. */
export function getArchivePath(
  category: ModelCategory,
  modelId: string,
  layout: { kind: 'archive'; format: SourceArchiveFormat },
  archiveFilename: string
): string {
  // Archives live alongside the model dir until extracted (or as the model itself
  // when extract: false). Convention is unchanged from today.
  return `${getModelsBaseDir(category)}/${archiveFilename}`;
}

/** Folder layouts: destination for one asset. */
export function getAssetDestPath(
  category: ModelCategory,
  modelId: string,
  relativePath: string
): string {
  return `${getModelDir(category, modelId)}/${relativePath}`;
}

/** Convenience: works for both. Returns the install-side path of the *first* asset
 *  (archive layout: the archive; folder layout: the first file). Mostly for legacy
 *  `unlink`-style cleanup paths. */
export function getFirstAssetPath(
  category: ModelCategory,
  modelId: string,
  model: { layout: SourceAssetLayout; assets: SourceAssetEntry[] }
): string;
```

`getTarArchivePath` and `getOnnxPath` (single-purpose helpers used by today's cleanup code) become thin wrappers that delegate to the new helpers; their callers in `bulkPurge.ts` / `localModels.ts` are updated.

---

## Pipeline behaviour per layout

| `layout.kind` | `extract` | `format` | Download engine action | Extraction action | Post-download |
|---|---|---|---|---|---|
| `archive` | `true` | ∈ `SUPPORTED_ARCHIVE_FORMATS` | Download one file to `getArchivePath(...)`. | `extractArchive(archive, getModelDir(...))`. | Validate model dir, write `manifest.json` + ready marker, optionally delete archive (`deleteArchiveAfterExtract: true`, default). |
| `archive` | `false` | ∈ `SUPPORTED_ARCHIVE_FORMATS` | Download one file to `getModelDir(...)/<filename>`. | None. | Validate that the file exists, write manifest with `sizeOnDisk: <archive size>`, write ready marker. **Do not** delete the archive. |
| `archive` | * | ∉ `SUPPORTED_ARCHIVE_FORMATS` | **Reject at plan time.** | — | — |
| `folder` | `false` (only) | `none` | Fan out: download every `assets[i]` to `getAssetDestPath(category, id, assets[i].relativePath)`. **No** asset is ever interpreted as an archive, regardless of file extension. | None. | Validate model dir, write manifest, ready marker. |

Folder fan-out is implemented in sub-06; this sub-plan only adjusts dispatching and gates.

---

## Implementation steps

1. Add `src/download/sources/formats.ts` + tests.
2. Update `src/download/types.ts`: replace `archiveExt: ModelArchiveExt` with `layout: SourceAssetLayout` and `assets: SourceAssetEntry[]`. Add the optional `sourceId` field. Remove `downloadUrl`. Remove the `ModelArchiveExt` type alias.
3. Update `src/download/sources/github-common.ts`: `buildSourceModelsFromGithubReleaseAssets` already emits the new layout (sub-02 stub). Now wire the orchestrator (`src/download/registry.ts`) to feed those models into `ModelMeta` *as-is*, without re-encoding into `archiveExt`.
4. Update `src/download/paths.ts`: new `getAssetDestPath`, `getFirstAssetPath`, layout-aware `getArchivePath`. Keep `getReadyMarkerPath` / `getManifestPath` unchanged.
5. Update `src/download/downloadTask.ts`:
   - Replace `model.archiveExt === 'tar.bz2'` / `'onnx'` branches with `model.layout.kind === 'archive'`.
   - At the top of `downloadModelOnce`, call `assertSupportedLayout({ layout: model.layout, source: model.sourceId, category, modelId: id })`.
   - Call `assertValidLayoutAssets(model)` at the same spot.
   - Use `getArchivePath(...)` / `getAssetDestPath(...)` accordingly.
   - **Folder layouts:** in this sub-plan keep a `TODO: handled in sub-06` (the multi-asset engine). Throw `DOWNLOAD_INVALID_LAYOUT` with a clear "Folder layouts arrive in sub-06" message if encountered. This guard is removed when sub-06 lands.
6. Update `src/download/modelExtraction.ts`:
   - Reject extraction (throw `DOWNLOAD_INVALID_LAYOUT`) when `model.layout.kind !== 'archive'` or `model.layout.extract !== true`. The existing check `if (model.archiveExt !== 'tar.bz2')` is replaced with this.
   - Pass the format explicitly into the native bridge — currently `extractTarBz2.ts` reads the source filename; nothing to change beyond renaming a log field for cleanliness.
7. Update `src/download/postDownloadProcessing.ts`:
   - `isArchive` parameter → `layout: SourceAssetLayout`.
   - Branch on `layout.kind` and `layout.extract`:
     - `archive + extract: true`: existing extraction path.
     - `archive + extract: false`: skip extraction; verify the archive file is present + size matches; write manifest (`sizeOnDisk = <archive bytes>`); write ready marker; **do not** delete the archive.
     - `folder`: assert sub-06 placeholder until folder fan-out lands.
8. Update `src/download/ensureModel.ts`:
   - `isArchive` → `isExtractableArchive = model.layout.kind === 'archive' && model.layout.extract`.
   - Resume extraction path is only entered for `isExtractableArchive`.
9. Update `src/download/bulkPurge.ts` and `localModels.ts`: replace `getArchivePath(category, id, model.archiveExt)` with the new `getFirstAssetPath(category, id, model)` (or fan-out for folder layouts when sub-06 lands).
10. Add Jest tests for the format gate + `extract: false` path (see below).
11. IST/SOLL review: run today's full download Jest suite + `example/` download showcase smoke for **all** existing categories. Output must match pre-rework, except where `extract: false` is explicitly requested.

---

## Test matrix (Jest)

### `formats.test.ts`

| # | Scenario | Expected |
|---|---|---|
| 1 | `isSupportedArchiveFormat('tar.bz2')` | `true`. |
| 2 | `isSupportedArchiveFormat('tar.zst')` | `true`. |
| 3 | `isSupportedArchiveFormat('tar.gz')` | `true` (when gzip filter is enabled in both build scripts). |
| 4 | `isSupportedArchiveFormat('tar.xz')` | `true` (when xz filter is enabled in both build scripts). |
| 5 | `isSupportedArchiveFormat('zip')` | `false`. |
| 6 | `assertSupportedLayout({ layout: { kind: 'archive', format: 'tar.bz2', extract: true } })` | No throw. |
| 7 | `assertSupportedLayout({ layout: { kind: 'archive', format: 'zip', extract: true } })` | `DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT`. |
| 8 | `assertSupportedLayout({ layout: { kind: 'folder', format: 'none', extract: false } })` | No throw (folder layouts bypass the format gate). |
| 9 | `assertValidLayoutAssets({ layout: { kind: 'archive' }, assets: [a, b] })` | `DOWNLOAD_INVALID_LAYOUT`. |
| 10 | `assertValidLayoutAssets({ layout: { kind: 'archive' }, assets: [] })` | `DOWNLOAD_INVALID_LAYOUT`. |
| 11 | `assertValidLayoutAssets({ layout: { kind: 'folder' }, assets: [{ relativePath: '../etc' }] })` | `DOWNLOAD_INVALID_LAYOUT`. |
| 12 | `assertValidLayoutAssets({ layout: { kind: 'folder' }, assets: [{ relativePath: '/abs' }] })` | `DOWNLOAD_INVALID_LAYOUT`. |
| 13 | `assertValidLayoutAssets({ layout: { kind: 'folder' }, assets: [{ relativePath: 'a//b' }] })` | `DOWNLOAD_INVALID_LAYOUT`. |
| 14 | Valid folder assets | No throw. |

### `formats.parity.test.ts` (drift guard)

This test ensures `SUPPORTED_ARCHIVE_FORMATS` doesn't silently drift from native + build-script reality. It reads the four source files at runtime (via `fs.readFileSync`) and re-derives the expected intersection.

| # | Source file | Extraction |
|---|---|---|
| 1 | `android/src/main/cpp/jni/archive/sherpa-onnx-archive-helper.cpp` | Grep `archive_read_support_filter_(\w+)` → set of registered filter names. |
| 2 | `ios/archive/sherpa-onnx-archive-helper.mm` | Same; assert the set matches #1. |
| 3 | `third_party/libarchive_prebuilt/build_libarchive_android.sh` | Grep `-DENABLE_(\w+)=ON` → set of enabled decoders. |
| 4 | `third_party/libarchive_prebuilt/build_libarchive_ios.sh` | Same. |

Then assert `SUPPORTED_ARCHIVE_FORMATS` equals the intersection of:
- filters registered in (#1 ∧ #2),
- decoders enabled in both (#3 ∧ #4).

The mapping `filter_name → SourceArchiveFormat literal` is encoded in the test (`bzip2 → 'tar.bz2'`, `gzip → 'tar.gz'`, `xz → 'tar.xz'`, `zstd → 'tar.zst'`). A new filter on the native side or a flipped `ENABLE_*` in a build script makes this test fail until `SUPPORTED_ARCHIVE_FORMATS` and `SourceArchiveFormat` (sub-01) are updated in lock-step.

### Pipeline tests

| # | Scenario | Expected |
|---|---|---|
| 1 | `downloadModel` with a model where `layout = { kind: 'archive', format: 'zip', extract: true }` | Throws `DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT` **before** any disk activity. |
| 2 | `downloadModel` with `layout = { kind: 'archive', format: 'tar.zst', extract: true }`; native `extractArchive` mocked to succeed | Archive downloaded; extracted; ready marker written. |
| 3 | `downloadModel` with `layout = { kind: 'archive', format: 'tar.bz2', extract: false }` | Archive downloaded; **no** extraction call to native; ready marker written; manifest carries `sizeOnDisk: <archive size>`; archive is **not** deleted (even with `deleteArchiveAfterExtract: true`). |
| 4 | `extractModel` invoked for a `layout.kind === 'folder'` model | Throws `DOWNLOAD_INVALID_LAYOUT`. |
| 5 | `extractModel` invoked for a `layout = { kind: 'archive', extract: false }` model | Throws `DOWNLOAD_INVALID_LAYOUT` (extraction is forbidden when the source explicitly opted out). |
| 6 | `getIncompleteExtractions(category)` for a `kind: 'archive'` resumable state | Behaves as today. |
| 7 | `getIncompleteExtractions(category)` returns nothing for `kind: 'folder'` models (sub-06 covers their resume semantics). | Pass. |

---

## Acceptance criteria

- `ModelMeta.archiveExt` no longer exists. `ModelMeta.downloadUrl` no longer exists.
- Format gate fires synchronously, before any I/O, for unsupported formats.
- `extract: false` archive downloads write the ready marker without invoking the extractor.
- `getDownloadStatePath` / `getExtractionStatePath` still work; their JSON payloads gain `layout` (replacing `model.archiveExt`).
- All today's pipeline tests still pass after the type migration (covered by sub-04 test updates).
- Sub-06's "folder layout" guard exists but is a placeholder: throwing `DOWNLOAD_INVALID_LAYOUT` with a deterministic message. The placeholder is **removed** by sub-06 (no extra audit needed there — sub-06's own tests would fail otherwise).
- IST/SOLL review: confirm a real `ensureModel(ModelCategory.Stt, 'sherpa-onnx-whisper-tiny')` end-to-end on device.

---

## Resolved decisions

### OQ-4.1 — Should `extract: false` write a `.ready` marker?

**Decision: Yes (accepted).**

`isModelDownloaded(category, id)` is the SDK's universal "model is on disk" check. Forcing consumers to special-case `extract: false` models would leak the layout into application code. The ready marker means: the bytes the provider promised are present on disk, regardless of layout.

### OQ-4.2 — Should we expose a `'onnx'` shorthand layout?

**Decision: No (accepted).**

A single ONNX file is a `kind: 'folder', assets: [{ relativePath: 'model.onnx', url, … }]`. Treating ONNX as a separate layout would re-introduce the today's two-branch coupling. The provider decides the relative path (matches the asset name).

### OQ-4.3 — Should the format gate be enforced inside the provider, or in the engine?

**Decision: In the engine (accepted).**

Providers may emit valid-looking layouts (`format: 'tar.zst'` today, more later). The engine is the only component that knows what the native extractor can actually handle. Gating in the engine keeps providers compute-free of native concerns.

### OQ-4.4 — How is the on-disk archive filename derived for `kind: 'archive'`?

**Decision: `assets[0].relativePath` (accepted).**

The provider chose the filename; the engine respects it. For `github_k2_fsa`, this is the GitHub release asset filename (`sherpa-onnx-whisper-tiny.tar.bz2`). For custom mirrors it's whatever the provider returned.
