# Sub-Plan 02: Source Registry + Built-in GitHub Providers

## Status
- Phase: **2**
- Depends on: sub-01 (cross-source contract).
- Prerequisite for: sub-03, sub-04, sub-05, sub-06, sub-07, sub-08.

## Cross-references
- Overview: [`download_manager_overview.md`](./download_manager_overview.md)
- Contract: [`sub-01-source-contract.md`](./sub-01-source-contract.md)
- Existing code:
  - `src/download/constants.ts` (`RELEASE_API_BASE`).
  - `src/download/paths.ts` (`CATEGORY_CONFIG`, `getReleaseUrl`, `getCacheDir`, …).
  - `src/download/registry.ts` (`fetchChecksumsFromRelease`, `refreshModels`, asset-name filters).

## Purpose

Stand up the **source registry** and migrate today's hard-coded GitHub paths to the new contract from sub-01, with **zero behavioural change** for default callers.

1. Introduce `registerSource(provider)`, `getSource(id)`, `setDefaultSourceForCategory(category, id)`, `getDefaultSourceForCategory(category)`, `configureSource(id, config)`, `listBuiltinSources()`.
2. Ship two built-in providers: `github_k2_fsa` (replaces `RELEASE_API_BASE`) and `github_xdcobra` (replaces today's per-category override for `Alignment`).
3. Move the today's filter logic (`isAssetSupportedForCategory`, `getAssetExtension`, `stripAssetExtension`, `toModelMeta`, `fetchChecksumsFromRelease`) into the new providers, so the registry orchestrator only sees `SourceModel[]`.
4. Wire `refreshModels` / `listModels` / `getModelById` so each accepts an optional `source` and falls back to the default.

The fetcher itself (`sourceFetch`) is sub-03's responsibility. **Until sub-03 lands**, the built-in providers continue to call the existing `fetch(...)` directly — that's the only acceptable form of debt this phase carries, and sub-03 closes it.

---

## Design principles

1. **Default routing matches today's behaviour, exactly.** Existing apps calling `refreshModels(ModelCategory.Tts)` without specifying a source must hit the same URL, parse the same body, and return the same `ModelMeta[]`. The whole point of the rework is *adding* sources, not *changing* the existing one.
2. **Providers are pure orchestrators of remote knowledge.** A provider builds `SourceModel`s from a remote API response. It owns category filters and id stripping. It does **not** read or write the disk.
3. **Per-source config lives in the registry, not in env vars or a global singleton.** `configureSource(sourceId, { headers, token, baseUrl? })` is the only mutation entry point.
4. **Default source per category is mutable at runtime, not at compile time.** SDK consumers swap defaults (e.g. self-hosted GitHub Enterprise mirror for `Alignment` instead of XDcobra) without recompiling.
5. **Custom sources are equal citizens.** The two built-ins are registered through the same `registerSource(provider)` call the SDK consumer would use.

---

## Files to add / modify

```
src/download/sources/
  registry.ts                    // registerSource, getSource, listBuiltinSources,
                                 // configureSource, getSourceConfig,
                                 // setDefaultSourceForCategory,
                                 // getDefaultSourceForCategory
  github-common.ts               // asset-name filters + checksum.txt parsing
                                 // (moved out of src/download/registry.ts)
  builtin/github-k2-fsa.ts       // SourceProvider for k2-fsa/sherpa-onnx
  builtin/github-xdcobra.ts      // SourceProvider for XDcobra/react-native-sherpa-onnx
  builtin/index.ts               // registers both builtins on import
  __tests__/registry.test.ts
  __tests__/builtin-github.test.ts

src/download/
  constants.ts                   // REMOVE: RELEASE_API_BASE
                                 // KEEP:   CACHE_TTL_MINUTES, MODEL_ARCHIVE_EXT, MODEL_ONNX_EXT
  paths.ts                       // CATEGORY_CONFIG keeps tag, cacheFile, baseDir;
                                 // releaseApiBase field DELETED (provider owns the URL).
  registry.ts                    // Becomes source-aware orchestrator (see Implementation steps).
  index.ts                       // Re-export source registry helpers.
```

---

## TypeScript shapes (new)

### `SourceConfig`

```ts
// src/download/sources/registry.ts (excerpt)
import type { RequestPolicy } from './types';

export interface SourceConfig {
  /** Additional headers; merged on top of provider defaults. */
  headers?: Record<string, string>;
  /** Bearer-style token. Folded into Authorization at fetch time. */
  token?: string;
  /** Auth scheme; defaults to 'Bearer'. */
  tokenScheme?: 'Bearer' | string;
  /**
   * Optional base URL override (e.g. self-hosted GitHub Enterprise).
   * The provider documents how it composes this with category/tag.
   */
  baseUrl?: string;
  /**
   * Default request policy *for this source*. Per-call policies override.
   * Default: { retries: 0 }.
   */
  requestPolicy?: RequestPolicy;
}
```

### Public registry functions

```ts
// src/download/sources/registry.ts (continued)
import type { SourceProvider } from './types';
import { ModelCategory } from '../types';
import { DownloadError } from './errors';

export function registerSource(provider: SourceProvider): void;
export function unregisterSource(id: string): void;
export function getSource(id: string): SourceProvider; // throws DOWNLOAD_UNKNOWN_SOURCE
export function tryGetSource(id: string): SourceProvider | undefined;

/** Iterates registered providers (built-ins + custom). */
export function listSources(): SourceProvider[];
/** Just the built-ins shipped by the SDK. */
export function listBuiltinSources(): SourceProvider[];

export function configureSource(id: string, config: SourceConfig): void;
export function getSourceConfig(id: string): Readonly<SourceConfig>;

export function setDefaultSourceForCategory(
  category: ModelCategory,
  sourceId: string
): void;
export function getDefaultSourceForCategory(
  category: ModelCategory
): string;

/** Initialized once on first registry access; idempotent. */
export function ensureBuiltinSourcesRegistered(): void;
```

### Built-in IDs

```ts
// src/download/sources/builtin/index.ts
export const BUILTIN_SOURCE_IDS = {
  GITHUB_K2_FSA: 'github_k2_fsa',
  GITHUB_XDCOBRA: 'github_xdcobra',
  // sub-05 adds HUGGINGFACE: 'huggingface'
} as const;
export type BuiltinSourceId =
  (typeof BUILTIN_SOURCE_IDS)[keyof typeof BUILTIN_SOURCE_IDS];
```

### Built-in default routing

```ts
// src/download/sources/builtin/index.ts (continued)
import {
  registerSource,
  setDefaultSourceForCategory,
} from '../registry';
import { ModelCategory } from '../../types';
import { githubK2FsaProvider } from './github-k2-fsa';
import { githubXdcobraProvider } from './github-xdcobra';

let registered = false;
export function registerBuiltinGithubSources(): void {
  if (registered) return;
  registerSource(githubK2FsaProvider);
  registerSource(githubXdcobraProvider);

  // Defaults — match today's behaviour exactly.
  for (const cat of Object.values(ModelCategory)) {
    setDefaultSourceForCategory(cat, BUILTIN_SOURCE_IDS.GITHUB_K2_FSA);
  }
  setDefaultSourceForCategory(
    ModelCategory.Alignment,
    BUILTIN_SOURCE_IDS.GITHUB_XDCOBRA
  );

  registered = true;
}
```

> `ensureBuiltinSourcesRegistered()` (exposed by the registry) calls `registerBuiltinGithubSources()` (Phase 2) and, in Phase 5, also the Hugging Face registration.

---

## Built-in providers

### `github_k2_fsa`

Drop-in replacement for today's hard-coded `RELEASE_API_BASE = 'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags'`. Reuses today's logic verbatim:

- URL: `https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/<tag>` where `<tag>` comes from `CATEGORY_CONFIG[category].tag` (still owned by `paths.ts`; sub-02 does not move that table).
- Response shape: `{ assets: Array<{ name, size, browser_download_url, digest? }> }`.
- Filtering: today's `isAssetSupportedForCategory(...)` + `getAssetExtension(...)` + `stripAssetExtension(...)` move from `registry.ts` to `src/download/sources/github-common.ts` (shared with `github_xdcobra`).
- Checksums: today's `fetchChecksumsFromRelease(category)` (downloads `checksum.txt` from the release tag) is implemented as `provider.getChecksums(category, ctx)`.
- Returns `SourceModel { layout: { kind: 'archive', format: 'tar.bz2', extract: true } | { kind: 'folder', format: 'none', extract: false } }`. The "ONNX single file" today (`archiveExt === 'onnx'`) maps to a one-file folder layout.

```ts
// src/download/sources/builtin/github-k2-fsa.ts
import type {
  SourceFetchContext,
  SourceModel,
  SourceProvider,
} from '../types';
import { ModelCategory } from '../../types';
import { DownloadError } from '../errors';
import {
  buildSourceModelsFromGithubReleaseAssets,
  parseChecksumTxt,
} from '../github-common';
import { getCategoryTag } from '../../paths'; // exposes only `tag`

const DEFAULT_BASE = 'https://api.github.com/repos/k2-fsa/sherpa-onnx';

function tagUrl(base: string, tag: string): string {
  return `${base.replace(/\/$/, '')}/releases/tags/${tag}`;
}

function checksumUrl(base: string, tag: string): string {
  // base: api.github.com/repos/k2-fsa/sherpa-onnx
  // checksum: github.com/k2-fsa/sherpa-onnx/releases/download/<tag>/checksum.txt
  const owner = base.split('/').slice(-2).join('/');
  return `https://github.com/${owner}/releases/download/${tag}/checksum.txt`;
}

export const githubK2FsaProvider: SourceProvider = {
  id: 'github_k2_fsa',
  label: 'GitHub · k2-fsa/sherpa-onnx',
  supportsCategory(category) {
    return category !== ModelCategory.Alignment;
  },
  async listModels(category, ctx) {
    const base = ctx /* config.baseUrl */ ? /* read by registry */ DEFAULT_BASE : DEFAULT_BASE; // pseudo
    const tag = getCategoryTag(category);
    const url = tagUrl(base, tag);
    // Phase 2 only: keep direct fetch; sub-03 swaps to `sourceFetch(url, ctx)`.
    const res = await fetch(url, { headers: ctx.headers });
    if (!res.ok) {
      throw new DownloadError(
        'DOWNLOAD_HTTP_STATUS',
        `GitHub k2-fsa list failed (${res.status})`,
        { status: res.status, source: this.id, category }
      );
    }
    const body = await res.json();
    return buildSourceModelsFromGithubReleaseAssets(category, body);
  },
  async getChecksums(category, ctx) {
    if (category === ModelCategory.Qnn) return new Map();
    const base = DEFAULT_BASE;
    const tag = getCategoryTag(category);
    const url = checksumUrl(base, tag);
    const res = await fetch(url, { headers: ctx.headers });
    if (!res.ok) return undefined;
    return parseChecksumTxt(await res.text());
  },
  defaultHeaders() {
    return { Accept: 'application/vnd.github+json' };
  },
};
```

> `getCategoryTag` is a new tiny helper in `paths.ts` that exposes `CATEGORY_CONFIG[category].tag` (the `cacheFile` and `baseDir` are still consumed by `paths.ts` itself). `releaseApiBase` on `CATEGORY_CONFIG` is **removed** in this phase.

### `github_xdcobra`

Identical shape, different base URL + a stricter category gate:

```ts
// src/download/sources/builtin/github-xdcobra.ts
const DEFAULT_BASE = 'https://api.github.com/repos/XDcobra/react-native-sherpa-onnx';

export const githubXdcobraProvider: SourceProvider = {
  id: 'github_xdcobra',
  label: 'GitHub · XDcobra/react-native-sherpa-onnx',
  supportsCategory(category) {
    // Today's only XDcobra-hosted category is Alignment, but the provider
    // is generic — `supportsCategory` accepts every category for symmetry.
    // The DEFAULT routing in `registerBuiltinGithubSources()` is what makes
    // XDcobra the *default* for Alignment only.
    return true;
  },
  async listModels(category, ctx) {
    const tag = getCategoryTag(category);
    const url = `${DEFAULT_BASE}/releases/tags/${tag}`;
    const res = await fetch(url, { headers: ctx.headers });
    if (!res.ok) {
      throw new DownloadError(
        'DOWNLOAD_HTTP_STATUS',
        `GitHub XDcobra list failed (${res.status})`,
        { status: res.status, source: this.id, category }
      );
    }
    return buildSourceModelsFromGithubReleaseAssets(
      category,
      await res.json()
    );
  },
  async getChecksums() {
    // XDcobra alignment release does not ship checksum.txt at the moment.
    // sha256 carried per-asset (today: `digest` field) feeds into SourceAssetEntry.
    return undefined;
  },
  defaultHeaders() {
    return { Accept: 'application/vnd.github+json' };
  },
};
```

### Shared helpers — `github-common.ts`

Move out of `src/download/registry.ts`, **without** behavioural change:

```ts
// src/download/sources/github-common.ts
import { ModelCategory } from '../types';
import type { SourceModel, SourceAssetEntry, SourceAssetLayout } from './types';
import { DownloadError } from './errors';

type ReleaseAsset = {
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string;
};

const MODEL_ARCHIVE_EXT = '.tar.bz2';
const MODEL_ONNX_EXT = '.onnx';

function getAssetExtension(name: string): 'tar.bz2' | 'onnx' | null { /* moved from registry.ts */ }
function stripAssetExtension(name: string, ext: 'tar.bz2' | 'onnx'): string { /* moved */ }
function isAssetSupportedForCategory(
  category: ModelCategory,
  name: string,
  ext: 'tar.bz2' | 'onnx'
): boolean { /* moved verbatim */ }
function parseDigestSha256(value?: string): string | undefined { /* moved */ }

export function parseChecksumTxt(content: string): Map<string, string> {
  // moved from src/download/validation.ts → parseChecksumFile, re-exported here for proximity.
}

export function buildSourceModelsFromGithubReleaseAssets(
  category: ModelCategory,
  body: { assets?: ReleaseAsset[] }
): SourceModel[] {
  const assets = Array.isArray(body?.assets) ? body.assets : [];
  const out: SourceModel[] = [];

  for (const asset of assets) {
    const ext = getAssetExtension(asset.name);
    if (!ext) continue;
    if (!isAssetSupportedForCategory(category, asset.name, ext)) continue;

    const id = stripAssetExtension(asset.name, ext);
    const sha256 = parseDigestSha256(asset.digest);
    const isArchive = ext === 'tar.bz2';

    const layout: SourceAssetLayout = isArchive
      ? { kind: 'archive', format: 'tar.bz2', extract: true }
      : { kind: 'folder', format: 'none', extract: false };

    const assetEntry: SourceAssetEntry = isArchive
      ? {
          relativePath: asset.name, // e.g. 'sherpa-onnx-whisper-tiny.tar.bz2'
          url: asset.browser_download_url,
          bytes: asset.size,
          sha256,
        }
      : {
          relativePath: asset.name, // e.g. 'silero_vad.onnx'
          url: asset.browser_download_url,
          bytes: asset.size,
          sha256,
        };

    out.push({
      id,
      displayName: id, // registry orchestrator may re-derive via `deriveDisplayName`.
      category,
      layout,
      assets: [assetEntry],
      bytes: asset.size,
    });
  }
  return out;
}
```

> The catalog-hints merge (`applyCatalogHintToMeta`) is **kept in the registry orchestrator** in sub-07 — sub-02 only re-routes URL/asset listing through providers.

---

## Implementation steps

1. Create `src/download/sources/registry.ts` with the function signatures + internal storage (two `Map`s: one for providers, one for per-source configs, plus a `Map<ModelCategory, string>` for category defaults).
2. Move asset-name filters and `parseChecksumFile` → `src/download/sources/github-common.ts`. Update `src/download/registry.ts` and `src/download/validation.ts` imports.
3. Add `src/download/sources/builtin/github-k2-fsa.ts` and `.../github-xdcobra.ts`.
4. Add `src/download/sources/builtin/index.ts` with `registerBuiltinGithubSources()`. Wire it into a one-shot bootstrap inside `src/download/sources/registry.ts → ensureBuiltinSourcesRegistered()` (called lazily on first `getSource(...)` or `getDefaultSourceForCategory(...)`).
5. Refactor `src/download/registry.ts → refreshModels(category, options)`:
   - Resolve `source = options?.source ?? getDefaultSourceForCategory(category)`.
   - Build `SourceFetchContext` from `getSourceConfig(source.id)` + `options?.requestPolicy` + `options?.signal`.
   - Call `provider.listModels(category, ctx)` → `SourceModel[]`.
   - Merge with `provider.getChecksums?.(category, ctx)` results when present (update `assets[*].sha256`).
   - Convert `SourceModel[]` → `ModelMeta[]` via the catalog-hints applicator (unchanged from today). **NOTE**: in this phase, `ModelMeta` still carries `archiveExt`; sub-04 migrates it to `layout`.
6. Update `paths.ts`:
   - Delete `releaseApiBase` field from `CATEGORY_CONFIG`.
   - Delete `getReleaseUrl(category)` (no longer referenced).
   - Add `export function getCategoryTag(category: ModelCategory): string` returning `CATEGORY_CONFIG[category].tag`.
7. Update `src/download/constants.ts`: remove `RELEASE_API_BASE`. Keep `CACHE_TTL_MINUTES`, `MODEL_ARCHIVE_EXT`, `MODEL_ONNX_EXT`.
8. Add re-exports to `src/download/index.ts`: `registerSource`, `unregisterSource`, `getSource`, `tryGetSource`, `listSources`, `listBuiltinSources`, `configureSource`, `getSourceConfig`, `setDefaultSourceForCategory`, `getDefaultSourceForCategory`, `BUILTIN_SOURCE_IDS`.
9. Add the test files (see test matrix below).

---

## Test matrix (Jest)

### `registry.test.ts`

| # | Scenario | Expected |
|---|---|---|
| 1 | `getSource('not_registered')` | Throws `DownloadError`, `code === 'DOWNLOAD_UNKNOWN_SOURCE'`. |
| 2 | After `ensureBuiltinSourcesRegistered()`: `getSource('github_k2_fsa')` | Returns the k2-fsa provider. |
| 3 | After `ensureBuiltinSourcesRegistered()`: `getDefaultSourceForCategory(ModelCategory.Stt)` | Returns `'github_k2_fsa'`. |
| 4 | After `ensureBuiltinSourcesRegistered()`: `getDefaultSourceForCategory(ModelCategory.Alignment)` | Returns `'github_xdcobra'`. |
| 5 | `registerSource(customProvider)` then `getSource(customProvider.id)` | Returns the registered provider. |
| 6 | `setDefaultSourceForCategory(ModelCategory.Stt, 'my_custom')` then `getDefaultSourceForCategory(ModelCategory.Stt)` | Returns `'my_custom'`. |
| 7 | `configureSource('github_k2_fsa', { token: 'tok' })` then `getSourceConfig('github_k2_fsa').token` | Returns `'tok'`. |
| 8 | `unregisterSource('github_k2_fsa')` then `getSource('github_k2_fsa')` | Throws `DOWNLOAD_UNKNOWN_SOURCE`. |
| 9 | `registerSource(providerWithDuplicateId)` when id already registered | Throws `DOWNLOAD_UNKNOWN_SOURCE` *(or a new `DOWNLOAD_DUPLICATE_SOURCE`? — see OQ-2.1)*. |
| 10 | `listBuiltinSources()` length | `>= 2` (k2-fsa, xdcobra). |

### `builtin-github.test.ts`

| # | Scenario | Expected |
|---|---|---|
| 1 | Mock `global.fetch` to return a representative GitHub assets payload for `Stt`; call `githubK2FsaProvider.listModels(ModelCategory.Stt, ctx)` | Returns `SourceModel[]` with `layout.kind === 'archive'`, `format: 'tar.bz2'`. |
| 2 | Same, but for `Vad` (ONNX assets) | Returns `SourceModel[]` with `layout.kind === 'folder'`. |
| 3 | Mock `fetch` 404 | Throws `DownloadError` with `code === 'DOWNLOAD_HTTP_STATUS'`, `status === 404`, `source === 'github_k2_fsa'`. |
| 4 | `githubK2FsaProvider.supportsCategory(ModelCategory.Alignment)` | `false`. |
| 5 | `githubXdcobraProvider.supportsCategory(ModelCategory.Alignment)` | `true`. |
| 6 | After registering builtins, call `refreshModels(ModelCategory.Stt)` with `fetch` mocked to a canned k2-fsa response | Returns the same `ModelMeta[]` shape today's tests assert (no regression). |
| 7 | After registering builtins, call `refreshModels(ModelCategory.Alignment)` with `fetch` mocked to a canned XDcobra response | URL hit is `https://api.github.com/repos/XDcobra/react-native-sherpa-onnx/releases/tags/alignment-models`. |
| 8 | `getChecksums(ModelCategory.Stt, ctx)` with mocked `checksum.txt` | Returns `Map<filename, sha256>` matching the existing parser. |
| 9 | `getChecksums(ModelCategory.Qnn, ctx)` | Returns empty `Map` without hitting the network. |

---

## Acceptance criteria

- All test-matrix entries pass.
- `RELEASE_API_BASE` and `CATEGORY_CONFIG[*].releaseApiBase` no longer exist anywhere in the codebase.
- `getReleaseUrl` no longer exists (replaced by per-provider URL construction).
- `refreshModels(category)` without `source` returns the **same** `ModelMeta[]` today's tests assert (with `fetch` mocked identically).
- `refreshModels(category, { source: 'github_xdcobra' })` overrides the default and hits the XDcobra base URL.
- Public re-exports from `src/download/index.ts` include the registry helpers + `BUILTIN_SOURCE_IDS`.
- No `retryWithBackoff` was reintroduced inside the new providers (any retry stays at the registry level, opt-in via `requestPolicy`, **and** is removed by sub-03 anyway).
- IST/SOLL review: rerun the existing download Jest suite + a manual smoke (`refreshModels(ModelCategory.Tts)` on a real device) and confirm parity.

---

## Resolved decisions

### OQ-2.1 — Should `registerSource` throw on duplicate id, or silently overwrite?

**Decision: Throw.**

`DownloadError('DOWNLOAD_UNKNOWN_SOURCE', 'duplicate registration')` is intentionally a narrow surface: the same code re-used because we already pay the cost of "unknown source" as a generic provider lookup failure. Silent overwrite hides bugs (especially in apps that register custom sources late in startup). A short `unregisterSource(id)` API is provided for the rare "override the builtin" case.

### OQ-2.2 — Should `configureSource(...)` merge with existing config or replace it?

**Decision: Merge (deep-merge `headers`; replace primitives).**

```ts
configureSource('huggingface', { headers: { 'X-Foo': '1' } });
configureSource('huggingface', { token: 'hf_xxx' });
// Both calls survive; final config has BOTH headers and token.
```

`configureSource(id, { headers: undefined })` is a no-op; `configureSource(id, { headers: {} })` resets headers (explicit empty is meaningful).

### OQ-2.3 — Should the registry be per-instance or module-global?

**Decision: Module-global (accepted).**

Mirrors the existing `downloadProgressListeners` / `activeDownloadTasks` module-globals in `src/download/`. App-level isolation isn't a use case; React Native processes have one JS runtime per app.

### OQ-2.4 — Where is the source registry initialized?

**Decision: Lazy bootstrap on first public-API call (accepted).**

`refreshModels(...)`, `downloadModel(...)`, `ensureModel(...)`, `registerSource(...)`, `getSource(...)`, and `getDefaultSourceForCategory(...)` all call `ensureBuiltinSourcesRegistered()` as their first line. This avoids importing `huggingface.ts` (sub-05) at module-load time when it isn't used.
