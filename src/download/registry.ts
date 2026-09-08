import {
  exists,
  mkdir,
  readFile,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import { CACHE_TTL_MINUTES } from './constants';
import { emitModelsListUpdated } from './downloadEvents';
import { getCacheDir, getCachePath, getPrimaryAssetFilename } from './paths';
import {
  DownloadError,
  DOWNLOAD_ERROR_CODES,
  type RequestPolicy,
  type SourceModel,
} from './sources';
import {
  buildSourceFetchContext,
  ensureBuiltinSourcesRegistered,
  getDefaultSourceForCategory,
  getSource,
  listSources,
} from './sources/registry';
import {
  ModelCategory,
  type CachePayload,
  type CacheStatus,
  type ModelMeta,
} from './types';

type SourceSelector = {
  source?: string | 'default';
};

export type RefreshModelsOptions = {
  forceRefresh?: boolean;
  cacheTtlMinutes?: number;
  signal?: AbortSignal;
  requestPolicy?: RequestPolicy;
} & SourceSelector;

type CachePayloadWithSource = CachePayload & {
  sourceId?: string;
};

const memoryCacheBySourceCategory = new Map<string, CachePayload>();
const checksumCacheBySourceCategory = new Map<string, Map<string, string>>();

function cacheKey(category: ModelCategory, sourceId: string): string {
  return `${sourceId}:${category}`;
}

function resolveSourceId(
  category: ModelCategory,
  source?: string | 'default'
): string {
  ensureBuiltinSourcesRegistered();

  if (!source || source === 'default') {
    return getDefaultSourceForCategory(category);
  }

  return source;
}

function isCacheFresh(payload: CachePayload, ttlMinutes: number): boolean {
  const updated = new Date(payload.lastUpdated).getTime();
  if (!updated) {
    return false;
  }

  const ageMs = Date.now() - updated;
  return ageMs < ttlMinutes * 60 * 1000;
}

function toModelMeta(
  sourceId: string,
  sourceModel: SourceModel
): ModelMeta | null {
  const primaryAsset = sourceModel.assets[0];
  if (!primaryAsset) {
    return null;
  }

  return {
    id: sourceModel.id,
    displayName: sourceModel.displayName,
    sourceId,
    layout: sourceModel.layout,
    assets: sourceModel.assets,
    bytes: sourceModel.bytes,
    sha256: primaryAsset.sha256,
    category: sourceModel.category,
    modelType: sourceModel.modelType,
    languages: sourceModel.languages,
    quantization: sourceModel.quantization,
    sizeTier: sourceModel.sizeTier,
    isStreaming: sourceModel.isStreaming,
    supportsQnn: sourceModel.supportsQnn,
    isHardwareSpecificUnsupported: sourceModel.isHardwareSpecificUnsupported,
  };
}

function toRequestPolicy(options?: RefreshModelsOptions): RequestPolicy {
  return options?.requestPolicy ?? { retries: 0 };
}

async function loadCacheFromDisk(
  category: ModelCategory,
  sourceId: string
): Promise<CachePayload | null> {
  const key = cacheKey(category, sourceId);
  const memoryCache = memoryCacheBySourceCategory.get(key);
  if (memoryCache) {
    return memoryCache;
  }

  const cachePath = getCachePath(category, sourceId);
  if (!(await exists(cachePath))) {
    return null;
  }

  const raw = await readFile(cachePath, 'utf8');
  const parsed = JSON.parse(raw) as CachePayloadWithSource;

  const payload: CachePayload = {
    lastUpdated: parsed.lastUpdated,
    models: parsed.models,
  };

  memoryCacheBySourceCategory.set(key, payload);
  return payload;
}

async function saveCache(
  category: ModelCategory,
  sourceId: string,
  payload: CachePayload
): Promise<void> {
  await mkdir(getCacheDir());
  await writeFile(
    getCachePath(category, sourceId),
    JSON.stringify({
      ...payload,
      sourceId,
    }),
    'utf8'
  );

  memoryCacheBySourceCategory.set(cacheKey(category, sourceId), payload);
}

async function getChecksumsForSource(
  category: ModelCategory,
  sourceId: string,
  options?: RefreshModelsOptions
): Promise<Map<string, string>> {
  const key = cacheKey(category, sourceId);
  const cached = checksumCacheBySourceCategory.get(key);
  if (cached) {
    return cached;
  }

  const provider = getSource(sourceId);
  if (!provider.getChecksums) {
    return new Map<string, string>();
  }

  try {
    const ctx = buildSourceFetchContext(sourceId, provider, {
      signal: options?.signal,
      requestPolicy: toRequestPolicy(options),
    });

    const checksums =
      (await provider.getChecksums?.(category, ctx)) ??
      new Map<string, string>();

    checksumCacheBySourceCategory.set(key, checksums);
    return checksums;
  } catch (error) {
    console.warn(
      `SherpaOnnxChecksum: Error fetching checksums for ${sourceId}:${category}:`,
      error
    );
    return new Map<string, string>();
  }
}

export async function listModels(
  category: ModelCategory,
  options?: SourceSelector
): Promise<ModelMeta[]> {
  ensureBuiltinSourcesRegistered();
  const sourceId = resolveSourceId(category, options?.source);
  const cache = await loadCacheFromDisk(category, sourceId);
  return cache?.models ?? [];
}

export async function refreshModels(
  category: ModelCategory,
  options?: RefreshModelsOptions
): Promise<ModelMeta[]> {
  ensureBuiltinSourcesRegistered();

  const sourceId = resolveSourceId(category, options?.source);
  const provider = getSource(sourceId);

  if (!provider.supportsCategory(category)) {
    throw new DownloadError(
      DOWNLOAD_ERROR_CODES.SOURCE_LIST_FAILED,
      `Source ${sourceId} does not support category ${category}`,
      {
        source: sourceId,
        category,
      }
    );
  }

  const ttl = options?.cacheTtlMinutes ?? CACHE_TTL_MINUTES;
  const cached = await loadCacheFromDisk(category, sourceId);

  if (!options?.forceRefresh && cached && isCacheFresh(cached, ttl)) {
    return cached.models;
  }

  try {
    const ctx = buildSourceFetchContext(sourceId, provider, {
      signal: options?.signal,
      requestPolicy: toRequestPolicy(options),
    });
    const sourceModels = await provider.listModels(category, ctx);

    const models = sourceModels
      .map((sourceModel) => toModelMeta(sourceId, sourceModel))
      .filter((model): model is ModelMeta => model != null)
      .filter((model) => model.isHardwareSpecificUnsupported !== true);

    const checksums = await getChecksumsForSource(category, sourceId, options);
    for (const model of models) {
      const archiveFilename = getPrimaryAssetFilename(
        model.id,
        model.layout,
        model.assets
      );
      const checksum = checksums.get(archiveFilename);

      if (checksum) {
        model.sha256 = checksum;
      } else if (model.sha256) {
        model.sha256 = model.sha256.toLowerCase();
      }
    }

    const payload: CachePayload = {
      lastUpdated: new Date().toISOString(),
      models,
    };

    await saveCache(category, sourceId, payload);
    emitModelsListUpdated(category, models);
    return models;
  } catch (error) {
    if (cached) {
      console.warn(
        `Failed to refresh models for ${sourceId}:${category}, using cached data:`,
        error
      );
      return cached.models;
    }

    throw error;
  }
}

export async function getModelsCacheStatus(
  category: ModelCategory,
  options?: SourceSelector
): Promise<CacheStatus> {
  const sourceId = resolveSourceId(category, options?.source);
  const cached = await loadCacheFromDisk(category, sourceId);

  if (!cached) {
    return {
      lastUpdated: null,
      source: 'cache',
    };
  }

  return {
    lastUpdated: cached.lastUpdated,
    source: 'cache',
  };
}

export async function getModelById(
  category: ModelCategory,
  id: string,
  options?: SourceSelector
): Promise<ModelMeta | null> {
  const models = await listModels(category, options);
  const found = models.find((model) => model.id === id);
  if (found) {
    return found;
  }

  if (!options?.source || options.source === 'default') {
    ensureBuiltinSourcesRegistered();
    const defaultSourceId = getDefaultSourceForCategory(category);
    const providers = listSources();
    for (const provider of providers) {
      if (provider.id === defaultSourceId) {
        continue;
      }
      if (!provider.supportsCategory(category)) {
        continue;
      }

      const altModels = await listModels(category, { source: provider.id });
      const altFound = altModels.find((model) => model.id === id);
      if (altFound) {
        return altFound;
      }
    }
  }

  return null;
}

export function clearMemoryCacheForCategory(category: ModelCategory): void {
  for (const key of memoryCacheBySourceCategory.keys()) {
    if (key.endsWith(`:${category}`)) {
      memoryCacheBySourceCategory.delete(key);
    }
  }

  for (const key of checksumCacheBySourceCategory.keys()) {
    if (key.endsWith(`:${category}`)) {
      checksumCacheBySourceCategory.delete(key);
    }
  }
}
