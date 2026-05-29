# Sub-Plan 07: Source-Aware Registry, Cache & Paths

## Status
- Phase: **7**
- Depends on: sub-01 (contract), sub-02 (registry), sub-03 (fetcher), sub-04 (layout), sub-05 (HF source), sub-06 (multi-asset engine).
- Prerequisite for: sub-08 (docs / example app / parity audit).

## Cross-references
- Overview: [`download_manager_overview.md`](./download_manager_overview.md)
- Existing registry orchestrator: `src/download/registry.ts`.
- Existing paths layer: `src/download/paths.ts`.
- Existing local install state: `src/download/localModels.ts`, `src/download/bulkPurge.ts`.

## Purpose

The previous sub-plans introduced *source identity* into the dataflow (`SourceProvider`, `SourceModel.id`, `ModelMeta.sourceId`) without yet making it visible in the **registry cache** or the **filesystem layout**. Sub-07 closes that gap:

1. **Registry cache** is namespaced per source: `cache/{sourceId}/{category}.json`.
2. **Model dir** is namespaced per source: `models/{sourceId}/{category}/{modelId}/`.
3. **`ModelMeta.sourceId`** becomes required (no longer optional) and is the canonical key for everything downstream of the registry.
4. **Public API additions**: `refreshModels(category, { source })` returns models scoped to that source; `listModels(category, { source })` reads the per-source cache; `getModelById(category, modelId, { source })` resolves within one source. Calls **without** a `source` use `getDefaultSourceForCategory(category)`.
5. **`getModelsCacheStatus(category, { source? })`** returns per-source metadata.
6. **Legacy on-disk paths** are wiped on first run (one-time purge), since the SDK is pre-release.

The end state is: two registered sources can hold the same `modelId` without colliding; `isModelDownloaded(category, modelId, { source })` returns the right answer per source; `ensureModel({ source: 'huggingface', ... })` and `ensureModel({ source: 'github_k2_fsa', ... })` for the same logical id live in independent disk subtrees.

---

## Design principles

1. **Source is **part of** identity, not metadata.** Once it lands in `ModelMeta`, every downstream helper takes either an explicit `source` or falls back to the registry default.
2. **Default source per category is the back-compat lever.** Calls without an explicit `source` resolve to today's source for that category — the public-facing function signatures stay backward-compatible (additive option only).
3. **Per-source caching reflects per-source listing reality.** A `tts-models.json` from `github_k2_fsa` and a `tts-models.json` from `huggingface` are different content sets. Storing them in one file would conflate.
4. **Filesystem migration is one-shot, not gradual.** Pre-release SDK status means the SDK can wipe legacy `models/{category}/{modelId}/` directories on first run and re-download. A migration helper logs the wipe so consumers can see what's happening on upgrade.
5. **`getStorageBasePath()` is unchanged.** The base path is still `<DocumentDirectoryPath>` — only the subtree under it is reorganized.

---

## Files to add / modify

```
src/download/
  paths.ts                       // Inject sourceId into directory and cache paths.
                                 //   - getCacheDir(): now `cache/{sourceId}/` per call.
                                 //   - getCachePath(category, sourceId): cache/{sourceId}/{cacheFile}.
                                 //   - getModelsBaseDir(category, sourceId): models/{sourceId}/{category}/.
                                 //   - getModelDir / getReadyMarkerPath / getManifestPath /
                                 //     getArchivePath / getAssetDestPath / getDownloadStatePath /
                                 //     getExtractionStatePath / getTempModelDir all accept sourceId.
  registry.ts                    // refreshModels/listModels/getModelById signatures gain an
                                 //   optional `source` and resolve via getDefaultSourceForCategory.
                                 //   memoryCacheByCategory → memoryCacheBySourceCategory.
  types.ts                       // ModelMeta.sourceId becomes REQUIRED.
                                 //   Cache file shape extended (per-source still single-tier list).
  localModels.ts                 // listDownloadedModels / isModelDownloaded / getModelPath /
                                 //   updateModelLastUsed / cleanupLeastRecentlyUsed gain
                                 //   optional `source`. Default resolution as registry.
  downloadTask.ts                // Resolve source from `model.sourceId`; pass through everywhere.
  modelExtraction.ts             // Same.
  ensureModel.ts                 // Same.
  bulkPurge.ts                   // Iterate all registered sources × all categories.
  protectedModelKeys.ts          // Protected key format becomes `<sourceId>:<category>:<modelId>`.
  activeModelOperations.ts       // makeModelOperationKey takes sourceId.
  __tests__/multiSource.test.ts  // NEW
  __tests__/legacyPurge.test.ts  // NEW

src/download/migration/
  legacyPurge.ts                 // One-shot wipe of legacy `<base>/sherpa-onnx/models/{category}/...`
                                 //   and legacy cache layout. Idempotent.
```

---

## TypeScript / payload shapes

### `ModelMeta` finalization

```ts
// src/download/types.ts (relevant deltas)
export type ModelMeta = {
  id: string;
  displayName: string;
  category: ModelCategory;
  /** REQUIRED after sub-07. */
  sourceId: string;

  layout: SourceAssetLayout;
  assets: SourceAssetEntry[];
  bytes: number;

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

The registry orchestrator sets `sourceId` from the resolved source before caching. No code path materializes a `ModelMeta` without one anymore.

### Paths

```ts
// src/download/paths.ts (skeleton)
export function getCacheDir(sourceId: string): string {
  return `${DocumentDirectoryPath}/sherpa-onnx/cache/${sourceId}`;
}
export function getCachePath(sourceId: string, category: ModelCategory): string {
  return `${getCacheDir(sourceId)}/${CATEGORY_CONFIG[category].cacheFile}`;
}
export function getModelsBaseDir(sourceId: string, category: ModelCategory): string {
  return `${DocumentDirectoryPath}/sherpa-onnx/models/${sourceId}/${category}`;
}
export function getModelDir(sourceId: string, category: ModelCategory, modelId: string): string {
  return `${getModelsBaseDir(sourceId, category)}/${safeId(modelId)}`;
}
export function getTempModelDir(
  sourceId: string,
  category: ModelCategory,
  modelId: string,
  tempToken: string
): string {
  return `${getModelsBaseDir(sourceId, category)}/.tmp-${safeId(modelId)}-${tempToken}`;
}
export function getDownloadStatePath(
  sourceId: string,
  category: ModelCategory,
  modelId: string
): string {
  return `${getModelsBaseDir(sourceId, category)}/.download-state-${safeId(modelId)}.json`;
}
export function getExtractionStatePath(
  sourceId: string,
  category: ModelCategory,
  modelId: string
): string {
  return `${getModelsBaseDir(sourceId, category)}/.extraction-state-${safeId(modelId)}.json`;
}
function safeId(modelId: string): string {
  // Replace path separators ('/', '\\') and HF-style '@' with safe chars.
  // Keep '.' and '-'. Reject other control characters at planning time
  // (DOWNLOAD_INVALID_LAYOUT).
  return modelId.replace(/[/\\]/g, '_').replace(/@/g, '_at_');
}
```

> HF revision-pinned ids (`b@main`) are mapped to a safe folder name (`b_at_main`) but kept as-is in `ModelMeta.id` and in cache JSON. The mapping is purely a filesystem-name encoder.

### Cache file

The cache payload shape stays:

```ts
export type CachePayload<T extends ModelMeta = ModelMeta> = {
  lastUpdated: string;
  models: T[];
};
```

What changes is the *location*: `cache/{sourceId}/{category}.json` (the `CATEGORY_CONFIG[category].cacheFile` value still names the file).

### Registry memory cache

```ts
// src/download/registry.ts (deltas)
const memoryCacheBySourceCategory =
  new Map<string /* sourceId */,
    Partial<Record<ModelCategory, CachePayload>>>();
const checksumCacheBySourceCategory =
  new Map<string /* sourceId */,
    Partial<Record<ModelCategory, Map<string, string>>>>();
```

### Public API additions

```ts
// src/download/registry.ts (signatures)
export type RegistryQueryOptions = {
  source?: string;
};

export function refreshModels(
  category: ModelCategory,
  options?: RefreshModelsOptions & RegistryQueryOptions
): Promise<ModelMeta[]>;

export function listModels(
  category: ModelCategory,
  options?: RegistryQueryOptions
): Promise<ModelMeta[]>;

export function getModelById(
  category: ModelCategory,
  id: string,
  options?: RegistryQueryOptions
): Promise<ModelMeta | null>;

export function getModelsCacheStatus(
  category: ModelCategory,
  options?: RegistryQueryOptions
): Promise<CacheStatus>;
```

The same `source` option is also added to:

- `clearModelsCache(category, options)`
- `listDownloadedModels(category, options)`
- `listDownloadedModelsWithMetadata(category, options)`
- `isModelDownloaded(category, modelId, options)`
- `getModelPath(category, modelId, options)`
- `updateModelLastUsed(category, modelId, options)`
- `cleanupLeastRecentlyUsed(category, options)`
- `deleteModel(category, modelId, options)`
- `downloadModel(category, modelId, options)`  *(already on `DownloadOptions` from sub-02; sub-07 makes it the authoritative resolver)*
- `pauseDownload`, `resumeDownload`, `deleteIncompleteDownload`
- `extractModel`, `pauseExtraction`, `resumeExtraction`, `deleteIncompleteExtraction`
- `getIncompleteDownloads`, `getIncompleteExtractions`
- `ensureModel`

Default resolution is identical everywhere:

```ts
function resolveSourceId(
  category: ModelCategory,
  override: string | undefined
): string {
  return override ?? getDefaultSourceForCategory(category);
}
```

### Active operation key

```ts
// src/download/activeModelOperations.ts
export function makeModelOperationKey(
  sourceId: string,
  category: ModelCategory,
  modelId: string
): string {
  return `${sourceId}:${category}:${modelId}`;
}
```

All call sites (`getProtectedKeys`, `getActiveDownloadTaskKeys`, etc.) are updated; the prefix invariant is now `<sourceId>:<category>:<modelId>`.

---

## Legacy purge

`src/download/migration/legacyPurge.ts` performs a one-shot wipe of:

- `<base>/sherpa-onnx/cache/*.json` (old per-category cache files at the top-level cache dir).
- `<base>/sherpa-onnx/models/<category>/...` directories that contain a `manifest.json` whose `model.sourceId` is missing.

The purge is idempotent (it writes a `.legacy-purged` sentinel under `<base>/sherpa-onnx/`); on second run it short-circuits. The purge runs **lazily** on the first download-manager public API call after upgrade. The user sees a single `console.warn` when the purge ran, listing how many directories were removed.

> Since the SDK is pre-release, no migration helper is exposed publicly: the wipe is internal. If an external consumer cares (unlikely), they can call `purgeAll()` themselves before upgrading.

---

## Implementation steps

1. Extend `src/download/paths.ts` to accept `sourceId` everywhere. Keep `CATEGORY_CONFIG[category].cacheFile` and `.tag` (still source-agnostic descriptors).
2. Update `src/download/types.ts`: `ModelMeta.sourceId` is required. Update `DownloadStateFile` / `ExtractionState` to require `sourceId`.
3. Update `src/download/registry.ts`:
   - Memory caches keyed by `sourceId, category`.
   - All entry points accept `source` and resolve via `resolveSourceId`.
   - `refreshModels` sets `model.sourceId = source.id` before writing into cache.
4. Update every `src/download/*.ts` file that uses `makeModelOperationKey(category, id)` to also pass `sourceId`. Resolve `sourceId` from `model.sourceId` whenever a `ModelMeta` is in scope; otherwise from the caller's option (default-resolved).
5. Update `src/download/bulkPurge.ts`: iterate the cartesian product of registered sources × categories.
6. Add `src/download/migration/legacyPurge.ts`. Call it lazily from `ensureBuiltinSourcesRegistered()` (after registration is done, before returning).
7. Update `src/download/index.ts` re-exports if any new types or helpers are public.
8. Update the example showcase: pass `source` to every download-manager call (default unchanged).
9. Update `docs/download-manager.md` (sub-08 owns the final doc pass; sub-07 stages the type changes so sub-08's edits are mechanical).
10. Add `multiSource.test.ts` and `legacyPurge.test.ts`.
11. IST/SOLL review: after all changes, run the registry test + multi-source matrix; confirm the actual on-disk layout matches the new spec (`tree models/` on a device showing `github_k2_fsa/`, `huggingface/`, etc.).

---

## Test matrix (Jest)

### `multiSource.test.ts`

| # | Scenario | Expected |
|---|---|---|
| 1 | After `ensureBuiltinSourcesRegistered`, call `refreshModels(ModelCategory.Tts)` (no source) | Reads from `cache/github_k2_fsa/tts-models.json` (the default for Tts). |
| 2 | `refreshModels(ModelCategory.Tts, { source: 'huggingface' })` | Reads from `cache/huggingface/tts-models.json`. |
| 3 | After both #1 and #2, `getModelsCacheStatus(ModelCategory.Tts, { source: 'github_k2_fsa' })` and `getModelsCacheStatus(..., { source: 'huggingface' })` | Return independent timestamps. |
| 4 | `ensureModel(ModelCategory.Tts, 'someId', { source: 'github_k2_fsa' })` then `ensureModel(ModelCategory.Tts, 'someId', { source: 'huggingface' })` (mocked providers return same id) | Two independent model dirs: `models/github_k2_fsa/tts/someId/` and `models/huggingface/tts/someId_at_main/`. |
| 5 | `isModelDownloaded(ModelCategory.Tts, 'someId', { source: 'github_k2_fsa' })` after #4 | `true`. `isModelDownloaded(... { source: 'huggingface' })` `false` (until that one downloads). |
| 6 | `deleteModel(... { source: 'huggingface' })` does not touch the k2-fsa install. | Pass. |
| 7 | `getProtectedKeys()` returns keys like `github_k2_fsa:tts:someId`. | Pass. |
| 8 | `purgeAll()` iterates over all registered sources and removes all installs. | Pass. |
| 9 | `setDefaultSourceForCategory(ModelCategory.Tts, 'huggingface')` then `refreshModels(ModelCategory.Tts)` (no explicit source) | Routes to `huggingface`. |
| 10 | Re-registering builtins does not reset user-overridden defaults. | Pass. |
| 11 | `ModelMeta` shape: `sourceId` is required (a `ModelMeta` missing it fails TS compile). | TS check via `@ts-expect-error`. |

### `legacyPurge.test.ts`

| # | Scenario | Expected |
|---|---|---|
| 1 | Filesystem mock: legacy `models/tts/<id>/manifest.json` (no `sourceId`); call any public API. | After call: legacy folder removed; `.legacy-purged` sentinel written. |
| 2 | Filesystem mock: sentinel already present; legacy folder also present. | Sentinel idempotency wins: legacy folder is left alone (the purge ran once before and the user re-populated; rare edge case). |
| 3 | Filesystem mock: no legacy folder, no sentinel. | Sentinel is written; nothing else happens. |
| 4 | Legacy cache file `cache/tts-models.json` (no per-source dir). | Cache file is deleted as part of the purge. |

---

## Acceptance criteria

- `ModelMeta.sourceId` is required; the type system enforces it.
- All filesystem paths under `<base>/sherpa-onnx/models/` and `<base>/sherpa-onnx/cache/` are nested under `<sourceId>/`.
- Two sources can hold the same `modelId` in the same `category` without colliding.
- Public API additions (`{ source }` everywhere) are backward-compatible: existing call sites work unchanged (default routing matches sub-02's defaults).
- `legacyPurge.ts` runs on first invocation after upgrade; subsequent runs no-op.
- IST/SOLL review: open Android Files / Xcode console after an `ensureModel` test, manually confirm the new directory structure.

---

## Resolved decisions

### OQ-7.1 — Should `sourceId` be allowed to contain `/`?

**Decision: No (accepted).**

Source ids are filesystem-folder names. The registry enforces `^[A-Za-z0-9_.-]+$` via a small validator inside `registerSource(provider)`. Custom providers with non-conforming ids throw a clear error at registration time.

### OQ-7.2 — Should `getStorageBasePath()` return a per-source base?

**Decision: No (accepted).**

The public `getStorageBasePath()` still returns `<DocumentDirectoryPath>`. Per-source subtree resolution stays an internal concern.

### OQ-7.3 — Should `clearModelsCache(category)` (no source) clear all sources?

**Decision: Yes (accepted).**

Callers wanting precision pass `{ source }`. Without an explicit source the operation is "blow away every per-source cache for this category" — matching today's *"clear cache, full stop"* semantics from the caller's point of view.

### OQ-7.4 — Should the registry validate that the provider's returned `id`s are unique across calls?

**Decision: Yes — duplicates in one `listModels` return throw `DOWNLOAD_SOURCE_LIST_FAILED` (accepted).**

A provider that returns two models with the same id is broken: the cache can't represent both. Catching it at orchestrator time prevents subtle install collisions.

### OQ-7.5 — Migration path for app installs that already ran the pre-rework SDK locally during dev?

**Decision: Lazy `legacyPurge` (accepted; documented).**

Pre-release means we don't owe consumers a smooth upgrade; logging the purge keeps the surprise minimal.
