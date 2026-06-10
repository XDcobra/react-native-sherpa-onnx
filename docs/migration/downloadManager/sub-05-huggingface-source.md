# Sub-Plan 05: Hugging Face Built-in Source

## Status
- Phase: **5**
- Depends on: sub-01 (contract), sub-02 (registry + built-ins), sub-03 (fetcher), sub-04 (folder layout).
- Prerequisite for: sub-06 (download engine multi-asset fan-out — folder layout becomes a real code path), sub-07 (registry cache namespacing), sub-08 (docs / example app).

## Cross-references
- Overview: [`download_manager_overview.md`](./download_manager_overview.md)
- Built-in source pattern: [`sub-02-source-registry-and-builtins.md`](./sub-02-source-registry-and-builtins.md)
- Fetcher contract: [`sub-03-fetcher-and-headers.md`](./sub-03-fetcher-and-headers.md)
- Folder layout contract: [`sub-04-archive-layout-and-extraction-flags.md`](./sub-04-archive-layout-and-extraction-flags.md)
- Inspiration / reference: [HF blog "LLM Inference on Edge"](https://huggingface.co/blog/llm-inference-on-edge) and the HF Hub API.

## Purpose

Add **`huggingface`** as a built-in source provider so that — out of the box — SDK consumers can pull models from `huggingface.co/<repo>` instead of the GitHub release bundles.

Hugging Face hosts models as **individual files in a repository**, not as archives. The provider therefore emits **folder-layout** `SourceModel`s (one per allowed repo/revision), with one `SourceAssetEntry` per relevant file.

The provider supports:

- **Allow-list of model specs**: which repos/revisions to surface for each category (sherpa-onnx-style asset filtering doesn't apply to HF).
- **Optional revision pin**: `main` by default, or any branch/tag/commit sha.
- **Per-file inclusion rules** based on filename extension / path glob.
- **HF token via `configureSource('huggingface', { token })`**.
- **Per-blob sha256** when present in the `siblings` API response.

This is the **only** sub-plan where multi-file folder layouts are exercised end-to-end before sub-06 hardens the engine. Sub-06's tests use this provider's models.

---

## Design principles

1. **Allow-list, not free-form discovery.** The provider does not "search" Hugging Face — it surfaces a list of pre-configured repos per category. The default list ships with a curated set of small sherpa-onnx-compatible models on HF; consumers extend or replace it via `configureSource`.
2. **Files are first-class, not archives.** Every `SourceModel` from this provider has `layout.kind === 'folder'`. The **archive-as-root invariant** (sub-04 → "Archive-as-root invariant") is the load-bearing rule here: even if `siblings` contains a file whose `rfilename` ends in `.tar.bz2`, `.tar.gz`, `.tar.xz`, or `.tar.zst`, the provider emits it as an ordinary `SourceAssetEntry` with that `relativePath`. The download engine writes those bytes to disk verbatim under `getModelDir(...)`; `extractArchive` is **not** invoked for any HF asset. SDK consumers that need extracted contents from an HF-hosted archive must operate on the on-disk file themselves. If a future HF model is *actually* a single root archive (extremely rare for the sherpa-onnx use case), the SDK user can register a custom provider that emits `kind: 'archive'` for it.
3. **Revision pinning is part of the model id.** The same repo at `main` and at `v0.1.0` are two different `SourceModel`s with distinct ids (e.g. `medmekk/Llama-3.2-1B-Instruct.GGUF@main` vs. `@v0.1.0`). The cache namespaces them.
4. **Token handling matches every other source.** `configureSource('huggingface', { token, tokenScheme: 'Bearer' })`. The fetcher (sub-03) folds this into `Authorization`. Provider never reads the token directly.
5. **No HF-specific URL hardcoding outside this file.** Every path uses helpers in `huggingface.ts` so future HF API changes (e.g. moving from `/api/models/...` to `/api/repos/...`) are contained.

---

## Files to add

```
src/download/sources/builtin/
  huggingface.ts                 // SourceProvider + types + URL helpers
  huggingface-defaults.ts        // Curated allow-list per ModelCategory
  __tests__/huggingface.test.ts
  __tests__/huggingface-fetch.test.ts
```

`src/download/sources/builtin/index.ts` is updated to also register the HF provider in `ensureBuiltinSourcesRegistered()` (sub-02 created the hook).

---

## TypeScript shapes

### Per-source config extensions

The HF provider accepts an optional **repo allow-list** beyond the generic `SourceConfig` shape from sub-02:

```ts
// src/download/sources/builtin/huggingface.ts
import type { ModelCategory } from '../../types';

export interface HuggingFaceRepoSpec {
  /** "<owner>/<name>" — e.g. "csukuangfj/sherpa-onnx-vits-en-ljs". */
  repo: string;
  /** Git ref. Defaults to 'main'. */
  revision?: string;
  /**
   * Friendly id; defaults to repo (without owner). The fully-qualified model id
   * inside the SDK is `<repoOwnerName>@<revision>`; this `id` is the
   * `displayName` and the local-storage subfolder name.
   */
  id?: string;
  /**
   * Filename allow-list. Defaults to a sensible set of model artifacts:
   *   - *.onnx
   *   - tokens.txt / vocab*.txt / lexicon*.txt
   *   - *.bin
   *   - config*.json / *.json
   *   - LICENSE / README*
   * Excludes by default: *.md (except README), images, large training assets.
   */
  includeFiles?: ReadonlyArray<string | RegExp>;
  /** Files to explicitly exclude (after include matches). */
  excludeFiles?: ReadonlyArray<string | RegExp>;
  /** Optional registry hints (mirrored into ModelMeta). */
  modelType?: string;
  languages?: string[];
  quantization?: 'fp16' | 'int8' | 'int8-quantized' | 'unknown';
  sizeTier?: 'tiny' | 'small' | 'medium' | 'large' | 'unknown';
  isStreaming?: boolean;
}

export interface HuggingFaceSourceConfig {
  /** Override the default allow-list, per category. */
  repos?: Partial<Record<ModelCategory, HuggingFaceRepoSpec[]>>;
  /**
   * If true, merge with the SDK's curated defaults
   * (`getDefaultHuggingFaceRepos(category)`). If false, the user's list replaces.
   * Default: false (replace) — consistent with `configureSource` semantics for headers
   * being "user supplies the full set" once they touch it.
   */
  mergeWithDefaults?: boolean;
}
```

> `HuggingFaceSourceConfig` is stored side-by-side with the generic `SourceConfig` for the source. The provider reads it via a small helper, not via the generic registry. This keeps the generic `SourceConfig` shape from being polluted with provider-specific fields.

A pair of utility functions:

```ts
// src/download/sources/builtin/huggingface.ts
export function configureHuggingFaceSource(config: HuggingFaceSourceConfig): void;
export function getHuggingFaceSourceConfig(): Readonly<HuggingFaceSourceConfig>;
```

Both are also re-exported from `src/download/index.ts`.

---

## URL contract

| Endpoint | URL |
|---|---|
| Repo metadata (incl. `siblings`) | `https://huggingface.co/api/models/<repo>` (optionally `?revision=<rev>`). |
| Individual file download | `https://huggingface.co/<repo>/resolve/<revision>/<path>` (follows redirects to CDN). |

The HF API returns `{ siblings: Array<{ rfilename: string; size?: number; lfs?: { sha256?: string; size?: number; }; }> }` among other fields. The provider:

1. Calls the metadata endpoint once per repo (via `sourceFetch`).
2. Filters `siblings` by the spec's `includeFiles` / `excludeFiles`.
3. Emits `SourceAssetEntry` per surviving file:
   - `relativePath = sibling.rfilename`
   - `url = https://huggingface.co/<repo>/resolve/<rev>/<rfilename>`
   - `bytes = sibling.lfs?.size ?? sibling.size`
   - `sha256 = sibling.lfs?.sha256`
4. Emits one `SourceModel` per repo spec:
   - `id = <ownerless-id>@<rev>` (e.g. `Llama-3.2-1B-Instruct.GGUF@main`).
   - `layout = { kind: 'folder', format: 'none', extract: false }`.
   - `bytes = sum of entries`.

```ts
function repoFileUrl(repo: string, revision: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/${revision}/${encodeURI(path)}`;
}

function modelIdFromSpec(spec: HuggingFaceRepoSpec): string {
  const rev = spec.revision ?? 'main';
  const ownerless = spec.repo.split('/').pop() ?? spec.repo;
  return `${ownerless}@${rev}`;
}
```

`encodeURI` (not `encodeURIComponent`) preserves `/` separators in repo paths like `weights/q8.bin`.

---

## Defaults — `huggingface-defaults.ts`

A small, curated map of repos per category. The intent is **only** to make the source useful out of the box for the showcase screen / quickstart. Production apps configure their own allow-list via `configureHuggingFaceSource(...)`.

```ts
// src/download/sources/builtin/huggingface-defaults.ts
import { ModelCategory } from '../../types';
import type { HuggingFaceRepoSpec } from './huggingface';

const DEFAULT_INCLUDE: ReadonlyArray<string | RegExp> = [
  /\.onnx$/i,
  /\btokens\.txt$/i,
  /\bvocab[\w.-]*\.txt$/i,
  /\blexicon[\w.-]*\.txt$/i,
  /\.bin$/i,
  /^config[\w.-]*\.json$/i,
  /^README/i,
  /^LICENSE/i,
];

const DEFAULTS: Partial<Record<ModelCategory, HuggingFaceRepoSpec[]>> = {
  [ModelCategory.Tts]: [
    /* curated short list, e.g. one or two community-hosted sherpa-onnx TTS repos */
  ],
  [ModelCategory.Stt]: [
    /* curated short list */
  ],
  // … add more on demand. Categories absent here return an empty list.
};

export function getDefaultHuggingFaceRepos(
  category: ModelCategory
): HuggingFaceRepoSpec[] {
  const list = DEFAULTS[category] ?? [];
  return list.map((spec) => ({
    includeFiles: DEFAULT_INCLUDE,
    ...spec,
  }));
}
```

> The exact default list is curated as part of sub-05 implementation (the list itself is a non-code change and can be updated independently). For the migration: **start with `[]` for every category** if no reliable HF mirror exists at implementation time; the showcase still demonstrates the provider via `configureHuggingFaceSource(...)` from the example app.

---

## Provider implementation sketch

```ts
// src/download/sources/builtin/huggingface.ts
import type {
  SourceFetchContext,
  SourceModel,
  SourceProvider,
} from '../types';
import { ModelCategory } from '../../types';
import { sourceFetch } from '../fetch';
import { DownloadError } from '../errors';
import {
  getDefaultHuggingFaceRepos,
} from './huggingface-defaults';

let userConfig: HuggingFaceSourceConfig | null = null;

export function configureHuggingFaceSource(config: HuggingFaceSourceConfig): void {
  userConfig = userConfig
    ? {
        ...userConfig,
        ...config,
        repos: { ...(userConfig.repos ?? {}), ...(config.repos ?? {}) },
      }
    : { ...config };
}

export function getHuggingFaceSourceConfig(): Readonly<HuggingFaceSourceConfig> {
  return userConfig ?? {};
}

function resolveRepos(category: ModelCategory): HuggingFaceRepoSpec[] {
  const cfg = userConfig;
  const defaults = getDefaultHuggingFaceRepos(category);
  if (!cfg?.repos?.[category]) return defaults;
  return cfg.mergeWithDefaults
    ? [...defaults, ...(cfg.repos[category] ?? [])]
    : (cfg.repos[category] ?? []);
}

interface SiblingResp {
  rfilename: string;
  size?: number;
  lfs?: { sha256?: string; size?: number };
}

export const huggingfaceProvider: SourceProvider = {
  id: 'huggingface',
  label: 'Hugging Face Hub',
  supportsCategory() {
    return true; // the allow-list per category gates effective support.
  },
  async listModels(category, ctx) {
    const specs = resolveRepos(category);
    const out: SourceModel[] = [];

    for (const spec of specs) {
      const rev = spec.revision ?? 'main';
      const url = `https://huggingface.co/api/models/${spec.repo}?revision=${encodeURIComponent(rev)}`;
      const { response } = await sourceFetch(url, ctx).catch((err) => {
        if (err instanceof DownloadError) throw err;
        throw new DownloadError(
          'DOWNLOAD_SOURCE_LIST_FAILED',
          `Hugging Face list failed for ${spec.repo}@${rev}`,
          { source: this.id, category, cause: err }
        );
      });

      let body: { siblings?: SiblingResp[] };
      try {
        body = (await response.json()) as { siblings?: SiblingResp[] };
      } catch (err) {
        throw new DownloadError(
          'DOWNLOAD_SOURCE_LIST_FAILED',
          `Hugging Face response was not JSON for ${spec.repo}@${rev}`,
          { source: this.id, category, cause: err }
        );
      }
      const siblings = Array.isArray(body.siblings) ? body.siblings : [];

      const matched = siblings.filter((sib) =>
        matchesIncludeExclude(sib.rfilename, spec.includeFiles, spec.excludeFiles)
      );
      if (matched.length === 0) continue;

      const id = modelIdFromSpec(spec);
      const assets = matched.map((sib) => ({
        relativePath: sib.rfilename,
        url: repoFileUrl(spec.repo, rev, sib.rfilename),
        bytes: sib.lfs?.size ?? sib.size,
        sha256: sib.lfs?.sha256?.toLowerCase(),
      }));
      const bytes = assets.reduce((acc, a) => acc + (a.bytes ?? 0), 0);

      out.push({
        id,
        displayName: spec.id ?? id,
        category,
        layout: { kind: 'folder', format: 'none', extract: false },
        assets,
        bytes,
        modelType: spec.modelType,
        languages: spec.languages,
        quantization: spec.quantization,
        sizeTier: spec.sizeTier,
        isStreaming: spec.isStreaming,
      });
    }
    return out;
  },
  defaultHeaders() {
    return { Accept: 'application/json' };
  },
};
```

`matchesIncludeExclude` is a small helper that accepts string equality, glob (basic `*`), or `RegExp`.

---

## Registry wiring

`src/download/sources/builtin/index.ts` is updated to register the HF provider in `ensureBuiltinSourcesRegistered()`:

```ts
import { huggingfaceProvider } from './huggingface';

export function registerBuiltinSources(): void {
  if (registered) return;
  registerSource(githubK2FsaProvider);
  registerSource(githubXdcobraProvider);
  registerSource(huggingfaceProvider);

  for (const cat of Object.values(ModelCategory)) {
    setDefaultSourceForCategory(cat, BUILTIN_SOURCE_IDS.GITHUB_K2_FSA);
  }
  setDefaultSourceForCategory(
    ModelCategory.Alignment,
    BUILTIN_SOURCE_IDS.GITHUB_XDCOBRA
  );
  registered = true;
}

export const BUILTIN_SOURCE_IDS = {
  GITHUB_K2_FSA: 'github_k2_fsa',
  GITHUB_XDCOBRA: 'github_xdcobra',
  HUGGINGFACE: 'huggingface',
} as const;
```

> Default routing **does not** make HF the default for any category. Apps wishing to pull from HF call `setDefaultSourceForCategory(category, 'huggingface')` explicitly or pass `source: 'huggingface'` at the call site.

---

## Implementation steps

1. Add `src/download/sources/builtin/huggingface.ts` and `.../huggingface-defaults.ts` with the shapes above.
2. Add `configureHuggingFaceSource` + `getHuggingFaceSourceConfig` re-exports to `src/download/index.ts`.
3. Update `src/download/sources/builtin/index.ts` to register the HF provider.
4. Add Jest tests in `__tests__/huggingface.test.ts` and `__tests__/huggingface-fetch.test.ts`.
5. End-to-end smoke (manual, in the example showcase from sub-08): configure one repo, call `refreshModels(ModelCategory.Stt, { source: 'huggingface' })`, then `ensureModel({ source: 'huggingface' })`.
6. IST/SOLL review: confirm HF token from `configureSource('huggingface', { token })` is folded into `Authorization` for both the metadata fetch and the file download (sub-06 fan-out picks the same headers).

---

## Test matrix (Jest)

### `huggingface.test.ts`

| # | Scenario | Expected |
|---|---|---|
| 1 | `modelIdFromSpec({ repo: 'a/b', revision: 'v1' })` | `'b@v1'`. |
| 2 | `modelIdFromSpec({ repo: 'a/b' })` | `'b@main'`. |
| 3 | `repoFileUrl('a/b', 'main', 'weights/q8.bin')` | `'https://huggingface.co/a/b/resolve/main/weights/q8.bin'`. |
| 4 | `matchesIncludeExclude('model.onnx', [/\.onnx$/], undefined)` | `true`. |
| 5 | `matchesIncludeExclude('README.md', [/^README/], [/\.md$/])` | `false` (exclude wins). |
| 6 | Default `getDefaultHuggingFaceRepos(ModelCategory.Stt)` (with current curation) | Returns array; every entry has non-empty `includeFiles`. |
| 7 | `configureHuggingFaceSource({ repos: { [Stt]: [{ repo: 'a/b' }] } })` then `getHuggingFaceSourceConfig()` | Carries the spec. |
| 8 | Second `configureHuggingFaceSource({ token: 'tok' })` does **not** wipe the repos set in #7. | Pass. |
| 9 | `resolveRepos(Stt)` with `mergeWithDefaults: false` (default) | Returns only the user-configured list. |
| 10 | `resolveRepos(Stt)` with `mergeWithDefaults: true` | Returns defaults + user list. |

### `huggingface-fetch.test.ts`

| # | Scenario | Expected |
|---|---|---|
| 1 | Mock `sourceFetch` → 200 with `siblings: [{ rfilename: 'model.onnx', size: 100 }, { rfilename: 'tokens.txt', size: 10 }]`; spec `{ repo: 'a/b' }` | One `SourceModel` with 2 assets, `bytes: 110`, `layout.kind === 'folder'`. |
| 2 | Same as #1 but include rule `[/\.onnx$/]` | One `SourceModel` with 1 asset (`tokens.txt` excluded). |
| 3 | Same as #1 but `sourceFetch` mock with `lfs: { sha256: 'AB...', size: 100 }` on `model.onnx` | Asset entry has `sha256: 'ab...'` (lowercased). |
| 4 | Mock `sourceFetch` → 401 | `DownloadError`, `code: 'DOWNLOAD_SOURCE_AUTH_FAILED'`, `source: 'huggingface'`. |
| 5 | Mock `sourceFetch` → 404 | `DownloadError`, `code: 'DOWNLOAD_HTTP_STATUS'`, `status: 404`. |
| 6 | `siblings: []` | Provider skips the spec (no `SourceModel` emitted), no throw. |
| 7 | Body is not JSON | `DOWNLOAD_SOURCE_LIST_FAILED`. |
| 8 | Two specs (`a/b@main`, `a/b@v1`) | Two distinct `SourceModel`s with ids `b@main` and `b@v1`. |
| 9 | `ctx.token = 'tok'` propagated by registry; `sourceFetch` outgoing Authorization is `Bearer tok` | Pass (mock `sourceFetch` and assert it was invoked with the right `ctx`). |
| 10 | `siblings: [{ rfilename: 'model.onnx', size: 100 }, { rfilename: 'weights/legacy.tar.bz2', size: 200 }, { rfilename: 'tokens.txt', size: 10 }]` | One `SourceModel`, `layout.kind === 'folder'`, **3 assets**, `bytes: 310`. The `.tar.bz2` is just another asset; `layout.format === 'none'`, `extract === false`. End-to-end this exercises the archive-as-root invariant on the provider side. |
| 11 | Single-sibling repo where the sole file is `model.tar.bz2` (`size: 500`) | One `SourceModel`, `layout.kind === 'folder'` (provider never emits archive layout for HF), `assets.length === 1`, `relativePath === 'model.tar.bz2'`. The downstream engine writes it as a plain file; no extraction. |

---

## Acceptance criteria

- `huggingface` is registered when `ensureBuiltinSourcesRegistered()` runs; `listBuiltinSources()` length is 3.
- `refreshModels(category, { source: 'huggingface' })` round-trips through the new provider, emits folder-layout `SourceModel`s, and the registry stores `ModelMeta` carrying `layout: { kind: 'folder', format: 'none', extract: false }`.
- `configureSource('huggingface', { token })` lets HF metadata fetches succeed when authenticated.
- All test-matrix entries pass.
- No HF-specific code lives outside `src/download/sources/builtin/huggingface*.ts`.
- IST/SOLL review: confirm a curated HF model `ensureModel(...)`s under `Documents/sherpa-onnx/models/<source>/<category>/<id>/` (the source-namespaced path becomes mandatory in sub-07 — in sub-05 the placeholder path is the existing `getModelDir(category, id)`; sub-07 retrofits the source segment without API change).

---

## Resolved decisions

### OQ-5.1 — Should HF discover models by user-supplied filter, or by allow-list?

**Decision: Allow-list (accepted).**

The Hub has hundreds of thousands of models; surfacing them by full-text search would be a UX rabbit hole and bring runtime cost. SDK consumers know which models they want; the source's job is to fetch *those*, robustly.

### OQ-5.2 — Should revision pinning default to `main` or to the latest tag?

**Decision: `main` (accepted).**

Tags are inconsistent across repos. `main` is universally available. Consumers wanting reproducibility pin to a sha (`revision: '<sha>'`).

### OQ-5.3 — Should the HF provider de-LFS download URLs?

**Decision: No — let the HF CDN do it via `resolve/<rev>/<path>` (accepted).**

`resolve/...` follows redirects to the right backend (LFS or not). The download engine (sub-06) configures the background downloader to follow redirects.

### OQ-5.4 — Should we trust `sibling.size` blindly, or HEAD each file at list time?

**Decision: Trust the metadata response (accepted).**

A HEAD-per-file at list time would multiply the request count by N and serve no robustness purpose: the download engine already validates the actual size after fetch and throws `DOWNLOAD_INTEGRITY_TRUNCATED` on mismatch.

### OQ-5.5 — How does the cache differentiate `b@main` (with the same upstream sha at different times)?

**Decision: It doesn't — the registry trusts the revision string.**

Consumers wanting reproducibility pin to a sha. The registry cache TTL (`CACHE_TTL_MINUTES`) keeps stale metadata bounded; sub-07's `getModelsCacheStatus` exposes the timestamp.
