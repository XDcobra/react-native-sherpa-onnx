import {
  exists,
  readFile,
  mkdir,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import { ModelCategory } from './types';
import type {
  ModelMetaBase,
  ModelArchiveExt,
  CachePayload,
  CacheStatus,
  TtsModelType,
  Quantization,
  SizeTier,
  TtsModelMeta,
} from './types';
import {
  CACHE_TTL_MINUTES,
  MODEL_ARCHIVE_EXT,
  MODEL_ONNX_EXT,
} from './constants';
import {
  getCacheDir,
  getCachePath,
  getArchiveFilename,
  getReleaseUrl,
  CATEGORY_CONFIG,
} from './paths';
import { parseChecksumFile } from './validation';
import { retryWithBackoff } from './retry';
import { emitModelsListUpdated } from './downloadEvents';

const memoryCacheByCategory: Partial<
  Record<ModelCategory, CachePayload<ModelMetaBase>>
> = {};

const checksumCacheByCategory: Partial<
  Record<ModelCategory, Map<string, string>>
> = {};

export async function fetchChecksumsFromRelease(
  category: ModelCategory
): Promise<Map<string, string>> {
  if (category === ModelCategory.Qnn) {
    return new Map<string, string>();
  }
  if (checksumCacheByCategory[category]) {
    return checksumCacheByCategory[category]!;
  }
  try {
    const checksums = await retryWithBackoff(
      async () => {
        const response = await fetch(
          `https://github.com/k2-fsa/sherpa-onnx/releases/download/${CATEGORY_CONFIG[category].tag}/checksum.txt`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch checksum.txt for ${category}: ${response.status}`
          );
        }
        const content = await response.text();
        return parseChecksumFile(content);
      },
      { maxRetries: 3, initialDelayMs: 1000 }
    );
    checksumCacheByCategory[category] = checksums;
    return checksums;
  } catch (error) {
    console.warn(
      `SherpaOnnxChecksum: Error fetching checksums for ${category}:`,
      error
    );
    return new Map();
  }
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((token) => token[0]!.toUpperCase() + token.slice(1))
    .join(' ');
}

function deriveDisplayName(id: string): string {
  const cleaned = id.replace(/^sherpa-onnx-/, '');
  return toTitleCase(cleaned);
}

function deriveType(id: string): TtsModelType {
  const lower = id.toLowerCase();
  if (lower.includes('vits')) return 'vits';
  if (lower.includes('kokoro')) return 'kokoro';
  if (lower.includes('matcha')) return 'matcha';
  if (lower.includes('kitten')) return 'kitten';
  if (lower.includes('pocket')) return 'pocket';
  if (lower.includes('zipvoice')) return 'zipvoice';
  if (lower.includes('supertonic')) return 'supertonic';
  return 'unknown';
}

function deriveQuantization(id: string): Quantization {
  const lower = id.toLowerCase();
  if (lower.includes('int8') && lower.includes('quant')) {
    return 'int8-quantized';
  }
  if (lower.includes('int8')) return 'int8';
  if (lower.includes('fp16')) return 'fp16';
  return 'unknown';
}

function deriveSizeTier(id: string): SizeTier {
  const lower = id.toLowerCase();
  if (lower.includes('tiny')) return 'tiny';
  if (lower.includes('small')) return 'small';
  if (lower.includes('medium')) return 'medium';
  if (lower.includes('large')) return 'large';
  if (lower.includes('low')) return 'small';
  return 'unknown';
}

function deriveLanguages(id: string): string[] {
  const tokens = id.split(/[-_]+/g);
  const languages = new Set<string>();
  for (const token of tokens) {
    if (/^[a-z]{2}$/.test(token)) {
      languages.add(token);
      continue;
    }
    if (/^[a-z]{2}[A-Z]{2}$/.test(token)) {
      languages.add(token.slice(0, 2).toLowerCase());
      continue;
    }
    if (/^[a-z]{2}-[A-Z]{2}$/.test(token)) {
      languages.add(token.slice(0, 2).toLowerCase());
    }
  }
  return Array.from(languages);
}

function getAssetExtension(name: string): ModelArchiveExt | null {
  if (name.endsWith(MODEL_ARCHIVE_EXT)) return 'tar.bz2';
  if (name.endsWith(MODEL_ONNX_EXT)) return 'onnx';
  return null;
}

function stripAssetExtension(name: string, ext: ModelArchiveExt): string {
  const suffix = `.${ext}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function isAssetSupportedForCategory(
  category: ModelCategory,
  name: string,
  ext: ModelArchiveExt
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
    default:
      return false;
  }
}

function parseDigestSha256(value?: string | null): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^sha256:([a-f0-9]{64})$/i);
  return match?.[1]?.toLowerCase();
}

function toTtsModelMeta(
  asset: {
    name: string;
    size: number;
    browser_download_url: string;
    digest?: string | null;
  },
  archiveExt: ModelArchiveExt
): TtsModelMeta | null {
  if (archiveExt !== 'tar.bz2') return null;
  const id = stripAssetExtension(asset.name, archiveExt);
  const type = deriveType(id);
  if (type === 'unknown') {
    console.warn('SherpaOnnxModelList: Unsupported model', id);
  }
  return {
    id,
    displayName: deriveDisplayName(id),
    type,
    languages: deriveLanguages(id),
    quantization: deriveQuantization(id),
    sizeTier: deriveSizeTier(id),
    downloadUrl: asset.browser_download_url,
    archiveExt,
    bytes: asset.size,
    sha256: parseDigestSha256(asset.digest),
    category: ModelCategory.Tts,
  };
}

function toGenericModelMeta(
  category: ModelCategory,
  asset: {
    name: string;
    size: number;
    browser_download_url: string;
    digest?: string | null;
  },
  archiveExt: ModelArchiveExt
): ModelMetaBase | null {
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
  asset: {
    name: string;
    size: number;
    browser_download_url: string;
    digest?: string | null;
  }
): ModelMetaBase | null {
  const archiveExt = getAssetExtension(asset.name);
  if (!archiveExt) return null;
  if (!isAssetSupportedForCategory(category, asset.name, archiveExt)) {
    return null;
  }
  if (category === ModelCategory.Tts) {
    return toTtsModelMeta(asset, archiveExt);
  }
  return toGenericModelMeta(category, asset, archiveExt);
}

async function loadCacheFromDisk<T extends ModelMetaBase>(
  category: ModelCategory
): Promise<CachePayload<T> | null> {
  const memoryCache = memoryCacheByCategory[category] as
    | CachePayload<T>
    | undefined;
  if (memoryCache) return memoryCache;
  const cachePath = getCachePath(category);
  const existsResult = await exists(cachePath);
  if (!existsResult) return null;
  const raw = await readFile(cachePath, 'utf8');
  const parsed = JSON.parse(raw) as CachePayload<T>;
  memoryCacheByCategory[category] = parsed as CachePayload<ModelMetaBase>;
  return parsed;
}

async function saveCache<T extends ModelMetaBase>(
  category: ModelCategory,
  payload: CachePayload<T>
): Promise<void> {
  await mkdir(getCacheDir());
  await writeFile(getCachePath(category), JSON.stringify(payload), 'utf8');
  memoryCacheByCategory[category] = payload as CachePayload<ModelMetaBase>;
}

function isCacheFresh<T extends ModelMetaBase>(
  payload: CachePayload<T>,
  ttlMinutes: number
): boolean {
  const updated = new Date(payload.lastUpdated).getTime();
  if (!updated) return false;
  const ageMs = Date.now() - updated;
  return ageMs < ttlMinutes * 60 * 1000;
}

export async function listModelsByCategory<T extends ModelMetaBase>(
  category: ModelCategory
): Promise<T[]> {
  const cache = await loadCacheFromDisk<T>(category);
  return cache?.models ?? [];
}

export async function refreshModelsByCategory<T extends ModelMetaBase>(
  category: ModelCategory,
  options?: {
    forceRefresh?: boolean;
    cacheTtlMinutes?: number;
    maxRetries?: number;
    signal?: AbortSignal;
  }
): Promise<T[]> {
  const ttl = options?.cacheTtlMinutes ?? CACHE_TTL_MINUTES;
  const cached = await loadCacheFromDisk<T>(category);

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

    const assets = Array.isArray(body?.assets) ? body.assets : [];
    const models: T[] = assets
      .map(
        (asset: {
          name: string;
          size: number;
          browser_download_url: string;
          digest?: string | null;
        }) =>
          toModelMeta(category, {
            name: asset.name,
            size: asset.size,
            browser_download_url: asset.browser_download_url,
            digest: asset.digest,
          })
      )
      .filter((model: ModelMetaBase | null): model is T => Boolean(model));

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

    const payload: CachePayload<T> = {
      lastUpdated: new Date().toISOString(),
      models,
    };
    await saveCache(category, payload);
    emitModelsListUpdated(category, models as ModelMetaBase[]);
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

export async function getModelsCacheStatusByCategory(
  category: ModelCategory
): Promise<CacheStatus> {
  const cached = await loadCacheFromDisk(category);
  if (!cached) {
    return { lastUpdated: null, source: 'cache' };
  }
  return { lastUpdated: cached.lastUpdated, source: 'cache' };
}

export async function getModelByIdByCategory<T extends ModelMetaBase>(
  category: ModelCategory,
  id: string
): Promise<T | null> {
  const models = await listModelsByCategory<T>(category);
  return models.find((model) => model.id === id) ?? null;
}

export function clearMemoryCacheForCategory(category: ModelCategory): void {
  delete memoryCacheByCategory[category];
  delete checksumCacheByCategory[category];
}
