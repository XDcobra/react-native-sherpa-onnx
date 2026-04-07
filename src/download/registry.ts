import {
  exists,
  mkdir,
  readFile,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import {
  CACHE_TTL_MINUTES,
  DEFAULT_TTS_CATALOG_HINTS_CHUNK_SIZE,
  MODEL_ARCHIVE_EXT,
  MODEL_ONNX_EXT,
} from './constants';
import { emitModelsListUpdated } from './downloadEvents';
import {
  CATEGORY_CONFIG,
  getArchiveFilename,
  getCacheDir,
  getCachePath,
  getReleaseUrl,
} from './paths';
import { retryWithBackoff } from './retry';
import {
  ModelCategory,
  type CachePayload,
  type CacheStatus,
  type ModelMeta,
  type Quantization,
  type SizeTier,
  type TtsModelType,
} from './types';
import { parseChecksumFile } from './validation';
import SherpaOnnx from '../NativeSherpaOnnx';

export type RefreshModelsOptions = {
  forceRefresh?: boolean;
  cacheTtlMinutes?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  /**
   * Max number of model ids per native `batchTtsCatalogHints` call when refreshing TTS catalog metadata.
   * Default: {@link DEFAULT_TTS_CATALOG_HINTS_CHUNK_SIZE}. Use `0` or `Infinity` to send all ids in one batch.
   */
  ttsCatalogHintsChunkSize?: number;
};

type ReleaseAsset = {
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string;
};

type NativeTtsCatalogHint = {
  modelId: string;
  modelType: string;
  languages: string[];
  quantization: string;
  sizeTier: string;
};

const memoryCacheByCategory: Partial<Record<ModelCategory, CachePayload>> = {};
const checksumCacheByCategory: Partial<
  Record<ModelCategory, Map<string, string>>
> = {};

const DEFAULT_RELEASE_REPO = 'k2-fsa/sherpa-onnx';

function getReleaseRepoFromConfig(category: ModelCategory): string {
  const releaseApiBase = CATEGORY_CONFIG[category].releaseApiBase;
  if (!releaseApiBase) {
    return DEFAULT_RELEASE_REPO;
  }

  const match = releaseApiBase.match(
    /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\/tags\/?$/
  );
  return match?.[1] ?? DEFAULT_RELEASE_REPO;
}

function getChecksumUrl(category: ModelCategory): string {
  const tag = CATEGORY_CONFIG[category].tag;
  const repo = getReleaseRepoFromConfig(category);
  return `https://github.com/${repo}/releases/download/${tag}/checksum.txt`;
}

export async function fetchChecksumsFromRelease(
  category: ModelCategory
): Promise<Map<string, string>> {
  if (category === ModelCategory.Qnn) {
    return new Map<string, string>();
  }

  const cached = checksumCacheByCategory[category];
  if (cached) {
    return cached;
  }

  try {
    const checksums = await retryWithBackoff(
      async () => {
        const response = await fetch(getChecksumUrl(category));
        if (!response.ok) {
          throw new Error(
            `Failed to fetch checksum.txt for ${category}: ${response.status}`
          );
        }

        const content = await response.text();
        return parseChecksumFile(content);
      },
      {
        maxRetries: 3,
        initialDelayMs: 1000,
      }
    );

    checksumCacheByCategory[category] = checksums;
    return checksums;
  } catch (error) {
    console.warn(
      `SherpaOnnxChecksum: Error fetching checksums for ${category}:`,
      error
    );
    return new Map<string, string>();
  }
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((token) => {
      const first = token[0] ?? '';
      return first.toUpperCase() + token.slice(1);
    })
    .join(' ');
}

function deriveDisplayName(id: string): string {
  const cleaned = id.replace(/^sherpa-onnx-/, '');
  return toTitleCase(cleaned);
}

function resolveTtsCatalogHintsChunkSize(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TTS_CATALOG_HINTS_CHUNK_SIZE;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor(value);
}

async function buildTtsCatalogHintsMap(
  ids: string[],
  chunkSize: number
): Promise<Map<string, NativeTtsCatalogHint>> {
  const map = new Map<string, NativeTtsCatalogHint>();
  if (ids.length === 0) {
    return map;
  }
  const step =
    Number.isFinite(chunkSize) && chunkSize > 0
      ? chunkSize
      : ids.length;
  for (let i = 0; i < ids.length; i += step) {
    const chunk = ids.slice(i, i + step);
    const rows = await SherpaOnnx.batchTtsCatalogHints(chunk);
    for (const row of rows) {
      map.set(row.modelId, row);
    }
  }
  return map;
}

function collectTtsModelIdsFromAssets(assets: ReleaseAsset[]): string[] {
  const out: string[] = [];
  for (const asset of assets) {
    const archiveExt = getAssetExtension(asset.name);
    if (archiveExt !== 'tar.bz2') {
      continue;
    }
    if (!isAssetSupportedForCategory(ModelCategory.Tts, asset.name, archiveExt)) {
      continue;
    }
    out.push(stripAssetExtension(asset.name, archiveExt));
  }
  return out;
}

function getAssetExtension(name: string): 'tar.bz2' | 'onnx' | null {
  if (name.endsWith(MODEL_ARCHIVE_EXT)) return 'tar.bz2';
  if (name.endsWith(MODEL_ONNX_EXT)) return 'onnx';
  return null;
}

function stripAssetExtension(name: string, ext: 'tar.bz2' | 'onnx'): string {
  const suffix = `.${ext}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function isAssetSupportedForCategory(
  category: ModelCategory,
  name: string,
  ext: 'tar.bz2' | 'onnx'
): boolean {
  const lower = name.toLowerCase();

  switch (category) {
    case ModelCategory.Tts:
      return ext === 'tar.bz2';
    case ModelCategory.Stt:
      return ext === 'tar.bz2' && !lower.includes('vad');
    case ModelCategory.Vad:
      return ext === 'onnx' && lower.includes('vad');
    case ModelCategory.Diarization:
      return ext === 'tar.bz2';
    case ModelCategory.Enhancement:
      return ext === 'onnx';
    case ModelCategory.Separation:
      return ext === 'tar.bz2' || ext === 'onnx';
    case ModelCategory.Qnn:
      return (
        ext === 'tar.bz2' &&
        lower.includes('sherpa-onnx-qnn') &&
        lower.includes('binary') &&
        lower.includes('seconds')
      );
    case ModelCategory.Alignment:
      return ext === 'tar.bz2';
    default:
      return false;
  }
}

function parseDigestSha256(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(/^sha256:([a-f0-9]{64})$/i);
  return match?.[1]?.toLowerCase();
}

function toTtsModelMeta(
  asset: ReleaseAsset,
  archiveExt: 'tar.bz2',
  hints: Map<string, NativeTtsCatalogHint>
): ModelMeta {
  const id = stripAssetExtension(asset.name, archiveExt);
  const hint = hints.get(id);
  if (!hint) {
    throw new Error(
      `Missing native TTS catalog hints for "${id}" — batchTtsCatalogHints did not return this id.`
    );
  }

  return {
    id,
    displayName: deriveDisplayName(id),
    downloadUrl: asset.browser_download_url,
    archiveExt,
    bytes: asset.size,
    sha256: parseDigestSha256(asset.digest),
    category: ModelCategory.Tts,
    type: hint.modelType as TtsModelType,
    languages: [...hint.languages],
    quantization: hint.quantization as Quantization,
    sizeTier: hint.sizeTier as SizeTier,
  };
}

function toGenericModelMeta(
  category: ModelCategory,
  asset: ReleaseAsset,
  archiveExt: 'tar.bz2' | 'onnx'
): ModelMeta {
  const id = stripAssetExtension(asset.name, archiveExt);

  return {
    id,
    displayName: deriveDisplayName(id),
    downloadUrl: asset.browser_download_url,
    archiveExt,
    bytes: asset.size,
    sha256: parseDigestSha256(asset.digest),
    category,
  };
}

function toModelMeta(
  category: ModelCategory,
  asset: ReleaseAsset,
  ttsHints: Map<string, NativeTtsCatalogHint>
): ModelMeta | null {
  const archiveExt = getAssetExtension(asset.name);
  if (!archiveExt) {
    return null;
  }

  if (!isAssetSupportedForCategory(category, asset.name, archiveExt)) {
    return null;
  }

  if (category === ModelCategory.Tts && archiveExt === 'tar.bz2') {
    return toTtsModelMeta(asset, archiveExt, ttsHints);
  }

  return toGenericModelMeta(category, asset, archiveExt);
}

async function loadCacheFromDisk(
  category: ModelCategory
): Promise<CachePayload | null> {
  const memoryCache = memoryCacheByCategory[category];
  if (memoryCache) {
    return memoryCache;
  }

  const cachePath = getCachePath(category);
  if (!(await exists(cachePath))) {
    return null;
  }

  const raw = await readFile(cachePath, 'utf8');
  const parsed = JSON.parse(raw) as CachePayload;
  memoryCacheByCategory[category] = parsed;
  return parsed;
}

async function saveCache(
  category: ModelCategory,
  payload: CachePayload
): Promise<void> {
  await mkdir(getCacheDir());
  await writeFile(getCachePath(category), JSON.stringify(payload), 'utf8');
  memoryCacheByCategory[category] = payload;
}

function isCacheFresh(payload: CachePayload, ttlMinutes: number): boolean {
  const updated = new Date(payload.lastUpdated).getTime();
  if (!updated) {
    return false;
  }

  const ageMs = Date.now() - updated;
  return ageMs < ttlMinutes * 60 * 1000;
}

export async function listModels(
  category: ModelCategory
): Promise<ModelMeta[]> {
  const cache = await loadCacheFromDisk(category);
  return cache?.models ?? [];
}

export async function refreshModels(
  category: ModelCategory,
  options?: RefreshModelsOptions
): Promise<ModelMeta[]> {
  const ttl = options?.cacheTtlMinutes ?? CACHE_TTL_MINUTES;
  const cached = await loadCacheFromDisk(category);

  if (!options?.forceRefresh && cached && isCacheFresh(cached, ttl)) {
    return cached.models;
  }

  try {
    const body = await retryWithBackoff(
      async () => {
        const response = await fetch(getReleaseUrl(category));
        if (!response.ok) {
          throw new Error(`Failed to fetch models: ${response.status}`);
        }
        return response.json();
      },
      {
        maxRetries: options?.maxRetries ?? 3,
        initialDelayMs: 1000,
        signal: options?.signal,
      }
    );

    const assets = Array.isArray(body?.assets)
      ? (body.assets as ReleaseAsset[])
      : [];

    let ttsHints = new Map<string, NativeTtsCatalogHint>();
    if (category === ModelCategory.Tts) {
      const ttsIds = collectTtsModelIdsFromAssets(assets);
      const chunk = resolveTtsCatalogHintsChunkSize(options?.ttsCatalogHintsChunkSize);
      ttsHints = await buildTtsCatalogHintsMap(ttsIds, chunk);
    }

    const models = assets
      .map((asset) => toModelMeta(category, asset, ttsHints))
      .filter((model): model is ModelMeta => model != null);

    const checksums = await fetchChecksumsFromRelease(category);
    for (const model of models) {
      const archiveFilename = getArchiveFilename(model.id, model.archiveExt);
      const sha256 = checksums.get(archiveFilename);

      if (sha256) {
        model.sha256 = sha256;
      } else if (model.sha256) {
        model.sha256 = model.sha256.toLowerCase();
      }
    }

    const payload: CachePayload = {
      lastUpdated: new Date().toISOString(),
      models,
    };

    await saveCache(category, payload);
    emitModelsListUpdated(category, models);
    return models;
  } catch (error) {
    if (cached) {
      console.warn(
        `Failed to refresh models for ${category}, using cached data:`,
        error
      );
      return cached.models;
    }

    throw error;
  }
}

export async function getModelsCacheStatus(
  category: ModelCategory
): Promise<CacheStatus> {
  const cached = await loadCacheFromDisk(category);
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
  id: string
): Promise<ModelMeta | null> {
  const models = await listModels(category);
  return models.find((model) => model.id === id) ?? null;
}

export function clearMemoryCacheForCategory(category: ModelCategory): void {
  delete memoryCacheByCategory[category];
  delete checksumCacheByCategory[category];
}
