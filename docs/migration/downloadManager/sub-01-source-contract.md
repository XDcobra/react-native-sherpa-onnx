# Sub-Plan 01: Cross-Source Contract & Error Codes

## Status
- Phase: **1 (foundation, JS-only)**
- Depends on: nothing — this is the foundation.
- Prerequisite for: sub-02, sub-03, sub-04, sub-05, sub-06, sub-07, sub-08.

## Cross-references
- Overview: [`download_manager_overview.md`](./download_manager_overview.md)
- Existing public surface: [`docs/download-manager.md`](../../download-manager.md)
- Existing implementation: `src/download/` (especially `types.ts`, `paths.ts`, `registry.ts`, `downloadTask.ts`, `modelExtraction.ts`).

## Purpose

Define the **shared TypeScript surface** that every source provider, the fetcher (sub-03), the download engine (sub-06), and the registry (sub-07) reuse:

1. The `SourceProvider` contract every built-in or user-registered source implements.
2. The `SourceModel` / `SourceAssetEntry` / `SourceAssetLayout` shape used to describe *one model* in source-agnostic terms.
3. The `SourceFetchContext` passed to every provider call (so providers receive headers/token/AbortSignal without each one re-implementing config plumbing).
4. The `DownloadError` class + the **frozen** `DownloadErrorCode` constant set.

Why this is its own sub-plan: every downstream phase consumes these types, and the error code set must be frozen before any provider, fetcher, or pipeline implementation references it. Drift between providers in code shape or error semantics is the worst failure mode this rework can have.

---

## Design principles

1. **One contract, one fetcher.** A provider implementation never calls `fetch(...)` directly; it always goes through the fetcher (sub-03) which receives `SourceFetchContext`. Providers therefore cannot accidentally bypass header/token/retry/error-mapping rules.
2. **Source-agnostic asset shape.** `SourceAssetEntry` describes one downloadable file. A model is either *one* archive entry or *N* file entries. The download engine never sees source-specific quirks.
3. **One error class, one code enum.** Consumers branch on `error.code` — never on `error.message`. `DownloadErrorCode` is a `as const` string set, not a TypeScript `enum`, so producer + consumer can use string literals interchangeably.
4. **`PauseError` and abort behaviour are preserved.** The new `DownloadError` does **not** replace `PauseError`; it sits alongside it. `PauseError` is updated to satisfy `error.code === 'DOWNLOAD_PAUSED'` to give consumers a unified code-based branch.
5. **No new public buffer/stream types.** This sub-plan only adds metadata + the provider contract. No native call surface is introduced here.

---

## Files to add

```
src/download/sources/
  index.ts                       // re-exports of all symbols in this sub-plan
  types.ts                       // SourceProvider, SourceModel, SourceAssetEntry,
                                 // SourceAssetLayout, SourceArchiveFormat,
                                 // SourceFetchContext, RequestPolicy
  errors.ts                      // DownloadError, DownloadErrorCode constant set,
                                 // type guards (isDownloadError, isPauseError-compat)
  __tests__/errors.test.ts
  __tests__/types.test.ts        // type-level + small runtime guards
```

Rationale for a dedicated `src/download/sources/` folder rather than dropping it into `src/download/types.ts`:
- The provider contract is intentionally distinct from the install-side types (`ModelMeta`, `Progress`, etc.). Co-locating both in `types.ts` would tangle "thing on disk after install" with "description of thing as the source sees it."
- Public re-exports from `src/download/index.ts` selectively expose the source-contract symbols (see [Re-exports](#re-exports)).

---

## TypeScript shapes

### `SourceArchiveFormat` and `SourceAssetLayout`

```ts
// src/download/sources/types.ts
import type { ModelCategory } from '../types';

/**
 * Archive formats the native extractor (`SherpaOnnx.extractArchive`) can handle.
 *
 * The runtime contract is declared in `ConfigureArchiveFormats(...)` inside
 * `android/src/main/cpp/jni/archive/sherpa-onnx-archive-helper.cpp` and
 * `ios/archive/sherpa-onnx-archive-helper.mm`, which currently registers:
 *   - `archive_read_support_format_tar`  (POSIX tar)
 *   - `archive_read_support_filter_bzip2` (.bz2)
 *   - `archive_read_support_filter_gzip`  (.gz)
 *   - `archive_read_support_filter_xz`    (.xz)
 *   - `archive_read_support_filter_zstd`  (.zst)
 *
 * The compile-time intersection across platforms is owned by the libarchive
 * build scripts:
 *   - `third_party/libarchive_prebuilt/build_libarchive_android.sh`
 *   - `third_party/libarchive_prebuilt/build_libarchive_ios.sh`
 *
 * `SUPPORTED_ARCHIVE_FORMATS` (sub-04 → `src/download/sources/formats.ts`) is the
 * single source of truth on the JS side and lists only the formats whose decoder
 * is enabled in **both** build scripts AND registered by the native helper.
 *
 * Anything else (`zip`, `7z`, …) is intentionally rejected at planning time with
 * `DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT`. Adding a new format is a *deliberate*,
 * paired change in:
 *   1. the native helper's `ConfigureArchiveFormats`,
 *   2. the two libarchive build scripts,
 *   3. this type union,
 *   4. `SUPPORTED_ARCHIVE_FORMATS`.
 */
export type SourceArchiveFormat = 'tar.bz2' | 'tar.gz' | 'tar.xz' | 'tar.zst';

/**
 * Describes how a model's assets are stored on the source.
 *
 *  - `archive` — one downloadable archive that, when extracted, yields the model
 *    folder. Today's `tar.bz2` GitHub release asset path. `extract: false`
 *    is allowed: the archive is stored as-is (consumer reads it back later).
 *  - `folder`  — N downloadable files that, taken together, are the model.
 *    Hugging Face siblings, custom mirrors that serve individual files.
 */
export type SourceAssetLayout =
  | {
      kind: 'archive';
      format: SourceArchiveFormat;
      extract: boolean;
    }
  | {
      kind: 'folder';
      /** Folder layouts never extract — the format token is fixed to 'none'. */
      format: 'none';
      extract: false;
    };
```

### `SourceAssetEntry` and `SourceModel`

```ts
// src/download/sources/types.ts (continued)

/**
 * One downloadable file from a source.
 *
 *  - For `archive` layout, exactly **one** entry whose `relativePath` is the
 *    archive filename and whose `url` resolves to the archive.
 *  - For `folder` layout, **>= 1** entries; each `relativePath` is the path
 *    relative to the final installed model folder root.
 */
export interface SourceAssetEntry {
  /**
   * POSIX-style path relative to the model folder root. Examples:
   *   - 'model.onnx'
   *   - 'tokens.txt'
   *   - 'weights/q8.bin'
   *   - 'sherpa-onnx-whisper-tiny.tar.bz2'  (archive layout)
   *
   * Must not contain `..`, `/./`, or absolute prefixes; the engine rejects those
   * with `DOWNLOAD_INVALID_LAYOUT` at plan time.
   */
  relativePath: string;
  url: string;
  bytes?: number;
  sha256?: string;
}

/**
 * Source-agnostic description of one model.
 *
 * The download engine + registry only consume this shape. Provider-specific
 * data (GitHub asset `browser_download_url`, HF `siblings`, custom server
 * responses, …) is fully normalized inside the provider.
 */
export interface SourceModel {
  /** Stable per-source model id. Source providers ensure stability across calls. */
  id: string;
  /** Human-readable label; mirrored into `ModelMeta.displayName`. */
  displayName: string;
  category: ModelCategory;
  layout: SourceAssetLayout;
  assets: SourceAssetEntry[];
  /** Sum of `assets[].bytes` if known; otherwise 0. Used for `checkDiskSpace`. */
  bytes: number;

  // Optional registry hints, mirrored into ModelMeta when the provider has them.
  modelType?: string;
  languages?: string[];
  quantization?: 'fp16' | 'int8' | 'int8-quantized' | 'unknown';
  sizeTier?: 'tiny' | 'small' | 'medium' | 'large' | 'unknown';
  isStreaming?: boolean;
  supportsQnn?: boolean;
  isHardwareSpecificUnsupported?: boolean;
}
```

### `RequestPolicy` and `SourceFetchContext`

```ts
// src/download/sources/types.ts (continued)

/**
 * Retry / timeout policy that callers can opt into.
 *
 * Defaults are **retries: 0** and **timeoutMs: undefined** — no implicit retry
 * loop anywhere in the new pipeline. Consumers can override via the public
 * `refreshModels(...)`, `downloadModel(...)`, `ensureModel(...)` option `requestPolicy`.
 */
export interface RequestPolicy {
  /** Number of *additional* attempts after the first failure. Default 0. */
  retries?: number;
  /** Initial delay between attempts in ms; exponential up to maxDelayMs. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Per-attempt request timeout in ms. */
  timeoutMs?: number;
}

/**
 * Context handed to every provider call AND to the fetcher.
 *
 * Built by the public API entry point from:
 *   - the source's own per-source configuration (`configureSource`)
 *   - the caller's `requestPolicy` and `signal` (via `EnsureModelOptions`, etc.)
 *   - the source registry's defaults
 */
export interface SourceFetchContext {
  /** Source id as registered. */
  sourceId: string;
  /** Headers merged from `configureSource({ headers })` and per-call overrides. */
  headers: Readonly<Record<string, string>>;
  /** Token shorthand; the fetcher folds it into `Authorization` if present. */
  token?: string;
  /** Bearer scheme used when `token` is set. Defaults to 'Bearer'. */
  tokenScheme?: 'Bearer' | string;
  requestPolicy: Readonly<RequestPolicy>;
  /** Optional cancellation. */
  signal?: AbortSignal;
}
```

### `SourceProvider`

```ts
// src/download/sources/types.ts (continued)
import type { ModelCategory } from '../types';

export interface SourceProvider {
  /** Stable id used by `registerSource` / `setDefaultSourceForCategory`. */
  readonly id: string;
  /** Human-friendly label for UIs (e.g. example showcase dropdown). */
  readonly label: string;

  /**
   * Whether this provider can serve the given category.
   * Allows the registry to surface meaningful errors instead of asking the
   * provider to fetch and then return an empty list.
   */
  supportsCategory(category: ModelCategory): boolean;

  /**
   * List models for one category.
   *
   * Throws a `DownloadError` (with a `DOWNLOAD_*` code) on failure;
   * **must not** throw a plain `Error`. The fetcher (sub-03) maps HTTP /
   * transport failures to the correct code, so most providers just await
   * `sourceFetch(...)` and rethrow the typed error.
   *
   * The provider is responsible for normalizing the response into
   * `SourceModel[]`. Filtering by archive ext / asset name kind is the
   * provider's job; the registry treats this list as the full source.
   */
  listModels(
    category: ModelCategory,
    ctx: SourceFetchContext
  ): Promise<SourceModel[]>;

  /**
   * Optional category-wide checksums. GitHub source returns the parsed
   * `checksum.txt`; Hugging Face source relies on per-blob sha256 carried
   * inside `SourceAssetEntry.sha256` and returns `undefined`.
   */
  getChecksums?(
    category: ModelCategory,
    ctx: SourceFetchContext
  ): Promise<Map<string, string> | undefined>;

  /**
   * Provider-default headers. The registry merges these with
   * `configureSource({ headers })` and per-call overrides before
   * building the `SourceFetchContext`.
   */
  defaultHeaders?(): Readonly<Record<string, string>>;
}
```

### `DownloadErrorCode` and `DownloadError`

```ts
// src/download/sources/errors.ts

/**
 * Frozen set of download error codes. Every member appears in the overview
 * (`docs/migration/downloadManager/download_manager_overview.md` →
 * "Cross-source error contract"). Adding a new code requires a parity
 * update on the overview AND a regenerated `docs/download-manager.md`.
 */
export const DOWNLOAD_ERROR_CODES = [
  'DOWNLOAD_UNKNOWN_SOURCE',
  'DOWNLOAD_SOURCE_LIST_FAILED',
  'DOWNLOAD_SOURCE_AUTH_FAILED',
  'DOWNLOAD_NETWORK_FAILED',
  'DOWNLOAD_HTTP_STATUS',
  'DOWNLOAD_INTEGRITY_CHECKSUM_MISMATCH',
  'DOWNLOAD_INTEGRITY_TRUNCATED',
  'DOWNLOAD_EXTRACT_FAILED',
  'DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT',
  'DOWNLOAD_DISK_SPACE_INSUFFICIENT',
  'DOWNLOAD_CANCELLED',
  'DOWNLOAD_PAUSED',
  'DOWNLOAD_INVALID_LAYOUT',
] as const;

export type DownloadErrorCode = (typeof DOWNLOAD_ERROR_CODES)[number];

export interface DownloadErrorOptions extends ErrorOptions {
  /** HTTP status, when relevant (DOWNLOAD_HTTP_STATUS, DOWNLOAD_SOURCE_AUTH_FAILED). */
  status?: number;
  /** Source id when the error originates inside a provider / fetch call. */
  source?: string;
  /** Category id when relevant (most cases). */
  category?: string;
  /** Model id when relevant. */
  modelId?: string;
}

export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  readonly status?: number;
  readonly source?: string;
  readonly category?: string;
  readonly modelId?: string;

  constructor(
    code: DownloadErrorCode,
    message: string,
    options: DownloadErrorOptions = {}
  ) {
    super(`${code}: ${message}`, { cause: options.cause });
    this.name = 'DownloadError';
    this.code = code;
    this.status = options.status;
    this.source = options.source;
    this.category = options.category;
    this.modelId = options.modelId;
  }
}

export function isDownloadError(value: unknown): value is DownloadError {
  return value instanceof DownloadError;
}

export function isDownloadErrorCode(value: unknown): value is DownloadErrorCode {
  return (
    typeof value === 'string' &&
    (DOWNLOAD_ERROR_CODES as readonly string[]).includes(value)
  );
}
```

### `PauseError` parity

`PauseError` (existing, in `src/download/types.ts`) is extended **non-breakingly**:

```ts
// In src/download/types.ts — adjustment to existing class
export class PauseError extends Error {
  public readonly category: ModelCategory;
  public readonly modelId: string;
  /** Added in sub-01 — lets consumers branch on `error.code === 'DOWNLOAD_PAUSED'`. */
  public readonly code: DownloadErrorCode = 'DOWNLOAD_PAUSED';

  constructor(
    category: ModelCategory,
    modelId: string,
    message = 'Operation paused'
  ) {
    super(message);
    this.name = 'PauseError';
    this.category = category;
    this.modelId = modelId;
  }
}
```

> The existing `isPauseError(error)` helper continues to work. The new `code` field exists to give consumers a single discrimination strategy: `if ('code' in error && error.code === 'DOWNLOAD_PAUSED')`.

### Re-exports

```ts
// src/download/sources/index.ts
export type {
  SourceProvider,
  SourceModel,
  SourceAssetEntry,
  SourceAssetLayout,
  SourceArchiveFormat,
  SourceFetchContext,
  RequestPolicy,
} from './types';
export {
  DownloadError,
  DOWNLOAD_ERROR_CODES,
  isDownloadError,
  isDownloadErrorCode,
  type DownloadErrorCode,
  type DownloadErrorOptions,
} from './errors';
```

The top-level `src/download/index.ts` adds, alongside its current re-exports:

```ts
// src/download/index.ts (additions)
export {
  DownloadError,
  DOWNLOAD_ERROR_CODES,
  isDownloadError,
  isDownloadErrorCode,
  type DownloadErrorCode,
  type SourceProvider,
  type SourceModel,
  type SourceAssetEntry,
  type SourceAssetLayout,
  type SourceArchiveFormat,
  type SourceFetchContext,
  type RequestPolicy,
} from './sources';
```

> `SourceProvider` is exported as a **type**: it is the contract custom-source authors implement. The implementation registry helpers (`registerSource`, etc.) ship in sub-02.

---

## Implementation steps

1. Create `src/download/sources/` folder.
2. Add `types.ts` with the shapes above. **No runtime code** in this file.
3. Add `errors.ts` with `DownloadError`, `DOWNLOAD_ERROR_CODES`, `isDownloadError`, `isDownloadErrorCode`.
4. Add `index.ts` with re-exports.
5. Append the new public type / class exports to `src/download/index.ts`.
6. Extend `PauseError` in `src/download/types.ts` with the `code` field (non-breaking).
7. Add Jest tests in `src/download/sources/__tests__/errors.test.ts` and `.../types.test.ts` (see test matrix below).

> No native changes. No behaviour change in the existing pipeline yet — sub-02 onwards build on this surface.

---

## Test matrix (Jest)

### `errors.test.ts`

| # | Input | Expected |
|---|---|---|
| 1 | `new DownloadError('DOWNLOAD_NETWORK_FAILED', 'eai_again')` | `error.name === 'DownloadError'`, `error.code === 'DOWNLOAD_NETWORK_FAILED'`, `error.message === 'DOWNLOAD_NETWORK_FAILED: eai_again'`. |
| 2 | `new DownloadError('DOWNLOAD_HTTP_STATUS', '503', { status: 503, source: 'github_k2_fsa' })` | `error.status === 503`, `error.source === 'github_k2_fsa'`. |
| 3 | `new DownloadError('DOWNLOAD_NETWORK_FAILED', 'underlying', { cause: originalErr })` | `error.cause === originalErr`. |
| 4 | `isDownloadError(new DownloadError(...))` | `true`. |
| 5 | `isDownloadError(new Error('foo'))` | `false`. |
| 6 | `isDownloadErrorCode('DOWNLOAD_UNKNOWN_SOURCE')` | `true`. |
| 7 | `isDownloadErrorCode('DOWNLOAD_TOTALLY_MADE_UP')` | `false`. |
| 8 | `isDownloadErrorCode(undefined)` | `false`. |
| 9 | `new PauseError(ModelCategory.Tts, 'm')` | `error.code === 'DOWNLOAD_PAUSED'`, existing `isPauseError(error) === true`. |
| 10 | `DOWNLOAD_ERROR_CODES` snapshot | Length matches the overview's "Cross-source error contract" table; **fails** the test if any code is added/removed without an overview update (manual review prompt). |

### `types.test.ts`

| # | Assertion | Expected |
|---|---|---|
| 1 | Type-level: a `SourceModel` with `layout.kind === 'archive'` and `assets.length > 1` is **typeable** (no compile-time guard — runtime guard in sub-06). | TS allows; runtime guard rejects. |
| 2 | Type-level (`expect-type` or equivalent): `SourceArchiveFormat` is exactly the union of formats listed in `ConfigureArchiveFormats` in `android/.../sherpa-onnx-archive-helper.cpp` AND `ios/.../sherpa-onnx-archive-helper.mm` (currently `'tar.bz2' \| 'tar.gz' \| 'tar.xz' \| 'tar.zst'`). | Pass. The test reads both helper files via `fs.readFileSync` and asserts each `archive_read_support_filter_*` call maps 1-to-1 to a `SourceArchiveFormat` literal — catches drift between native + JS contract. |
| 3 | Type-level: a `SourceProvider` lacking `listModels` does not type-check (negative test via `// @ts-expect-error`). | Pass. |
| 4 | Runtime: instantiating an object that satisfies `SourceProvider` (with stub `listModels`) does not throw. | Pass. |

---

## Acceptance criteria

- `DownloadError` + `DOWNLOAD_ERROR_CODES` + `isDownloadError` + `isDownloadErrorCode` exported from `react-native-sherpa-onnx/download`.
- `SourceProvider`, `SourceModel`, `SourceAssetEntry`, `SourceAssetLayout`, `SourceArchiveFormat`, `SourceFetchContext`, `RequestPolicy` exported as types.
- All test-matrix entries above pass.
- `PauseError` carries `code: 'DOWNLOAD_PAUSED'` without breaking any existing consumer (existing tests stay green).
- `src/download/types.ts` is otherwise unchanged.
- No changes to native code, native bindings, or to `downloadTask.ts` / `modelExtraction.ts` / `registry.ts` behaviour yet — those happen in subsequent phases.

---

## Resolved decisions

### OQ-1.1 — Should the registry-side `ModelMeta` keep `archiveExt` (for compat) or be replaced with `layout`?

**Decision: Replaced with `layout` (clean cut, sub-04 / sub-07).**

The SDK is pre-release. Keeping `archiveExt` as an alias would force every consumer to read two fields. The breaking change is documented in the overview's "Definition of done" and surfaces only at type level for existing app code (today's `archiveExt: 'tar.bz2' | 'onnx'` maps cleanly to `layout: { kind: 'archive', format: 'tar.bz2', extract: true }` and `layout: { kind: 'archive', format: 'tar.bz2', extract: false }` respectively — but ONNX assets become `{ kind: 'folder', extract: false, assets: [...single...] }`).

### OQ-1.2 — Should `DownloadErrorCode` be a TS enum or a `as const` string list?

**Decision: `as const` string list (accepted).**

Mirrors the existing `LIVE_OFFLINE_SEGMENTATION_REQUIRED` pattern in `src/livePipeline/validation.ts`. Producers/consumers can use the literal string anywhere without importing an enum; bundlers preserve the union.

### OQ-1.3 — Should `PauseError` be replaced by `DownloadError('DOWNLOAD_PAUSED', …)`?

**Decision: Keep `PauseError`, add a `code` field (accepted).**

`PauseError` is referenced by `isPauseError` and is part of the documented public surface. Replacing it would force consumers to rewrite their error branches. Adding a `code: 'DOWNLOAD_PAUSED'` field is additive and lets consumers migrate to code-based discrimination at their own pace.

### OQ-1.4 — Where do tokens live?

**Decision: `SourceFetchContext.token` (accepted; implementation in sub-02 + sub-03).**

Per-source token storage lives in the source registry's per-source config (`configureSource(sourceId, { token })`), set at app startup. The fetcher folds `token` into `Authorization: <scheme> <token>` immediately before sending. Tokens are **never** logged.
