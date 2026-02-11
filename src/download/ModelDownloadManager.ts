import { Platform } from 'react-native';
import RNFS from 'react-native-fs';
import { extractTarBz2 } from './extractTarBz2';

const RELEASE_API_BASE =
  'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags';
const CACHE_TTL_MINUTES = 24 * 60;
const MODEL_ARCHIVE_EXT = '.tar.bz2';

export enum ModelCategory {
  Tts = 'tts',
  Stt = 'stt',
  Vad = 'vad',
  Diarization = 'diarization',
  Enhancement = 'enhancement',
  Separation = 'separation',
}

export type TtsModelType =
  | 'vits'
  | 'kokoro'
  | 'matcha'
  | 'kitten'
  | 'zipvoice'
  | 'unknown';

export type Quantization = 'fp16' | 'int8' | 'int8-quantized' | 'unknown';

export type SizeTier = 'tiny' | 'small' | 'medium' | 'large' | 'unknown';

export type ModelMetaBase = {
  id: string;
  displayName: string;
  downloadUrl: string;
  archiveExt: 'tar.bz2';
  bytes: number;
  sha256?: string;
  category: ModelCategory;
};

export type TtsModelMeta = ModelMetaBase & {
  type: TtsModelType;
  languages: string[];
  quantization: Quantization;
  sizeTier: SizeTier;
  category: ModelCategory.Tts;
};

export type DownloadProgress = {
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
};

export type DownloadResult = {
  modelId: string;
  localPath: string;
};

type CachePayload<T extends ModelMetaBase> = {
  lastUpdated: string;
  models: T[];
};

type CacheStatus = {
  lastUpdated: string | null;
  source: 'cache' | 'remote';
};

const memoryCacheByCategory: Partial<
  Record<ModelCategory, CachePayload<ModelMetaBase>>
> = {};

const CATEGORY_CONFIG: Record<
  ModelCategory,
  { tag: string; cacheFile: string; baseDir: string }
> = {
  [ModelCategory.Tts]: {
    tag: 'tts-models',
    cacheFile: 'tts-models.json',
    baseDir: `${RNFS.DocumentDirectoryPath}/sherpa-onnx/models/tts`,
  },
  [ModelCategory.Stt]: {
    tag: 'asr-models',
    cacheFile: 'asr-models.json',
    baseDir: `${RNFS.DocumentDirectoryPath}/sherpa-onnx/models/stt`,
  },
  [ModelCategory.Vad]: {
    tag: 'vad-models',
    cacheFile: 'vad-models.json',
    baseDir: `${RNFS.DocumentDirectoryPath}/sherpa-onnx/models/vad`,
  },
  [ModelCategory.Diarization]: {
    tag: 'speaker-diarization-models',
    cacheFile: 'diarization-models.json',
    baseDir: `${RNFS.DocumentDirectoryPath}/sherpa-onnx/models/diarization`,
  },
  [ModelCategory.Enhancement]: {
    tag: 'speech-enhancement-models',
    cacheFile: 'enhancement-models.json',
    baseDir: `${RNFS.DocumentDirectoryPath}/sherpa-onnx/models/enhancement`,
  },
  [ModelCategory.Separation]: {
    tag: 'source-separation-models',
    cacheFile: 'separation-models.json',
    baseDir: `${RNFS.DocumentDirectoryPath}/sherpa-onnx/models/separation`,
  },
};

function getCacheDir(): string {
  return `${RNFS.DocumentDirectoryPath}/sherpa-onnx/cache`;
}

function getCachePath(category: ModelCategory): string {
  return `${getCacheDir()}/${CATEGORY_CONFIG[category].cacheFile}`;
}

function getModelsBaseDir(category: ModelCategory): string {
  return CATEGORY_CONFIG[category].baseDir;
}

function getModelDir(category: ModelCategory, modelId: string): string {
  return `${getModelsBaseDir(category)}/${modelId}`;
}

function getArchivePath(category: ModelCategory, modelId: string): string {
  return `${getModelsBaseDir(category)}/${modelId}${MODEL_ARCHIVE_EXT}`;
}

function getReadyMarkerPath(category: ModelCategory, modelId: string): string {
  return `${getModelDir(category, modelId)}/.ready`;
}

function getManifestPath(category: ModelCategory, modelId: string): string {
  return `${getModelDir(category, modelId)}/manifest.json`;
}

function getReleaseUrl(category: ModelCategory): string {
  return `${RELEASE_API_BASE}/${CATEGORY_CONFIG[category].tag}`;
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
  if (lower.includes('zipvoice')) return 'zipvoice';
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

function toTtsModelMeta(asset: {
  name: string;
  size: number;
  browser_download_url: string;
}): TtsModelMeta | null {
  if (!asset.name.endsWith(MODEL_ARCHIVE_EXT)) {
    return null;
  }

  const id = asset.name.replace(MODEL_ARCHIVE_EXT, '');
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
    archiveExt: 'tar.bz2',
    bytes: asset.size,
    category: ModelCategory.Tts,
  };
}

function toGenericModelMeta(
  category: ModelCategory,
  asset: {
    name: string;
    size: number;
    browser_download_url: string;
  }
): ModelMetaBase | null {
  if (!asset.name.endsWith(MODEL_ARCHIVE_EXT)) {
    return null;
  }

  const id = asset.name.replace(MODEL_ARCHIVE_EXT, '');
  return {
    id,
    displayName: deriveDisplayName(id),
    downloadUrl: asset.browser_download_url,
    archiveExt: 'tar.bz2',
    bytes: asset.size,
    category,
  };
}

function toModelMeta(
  category: ModelCategory,
  asset: {
    name: string;
    size: number;
    browser_download_url: string;
  }
): ModelMetaBase | null {
  if (category === ModelCategory.Tts) {
    return toTtsModelMeta(asset);
  }
  return toGenericModelMeta(category, asset);
}

async function loadCacheFromDisk<T extends ModelMetaBase>(
  category: ModelCategory
): Promise<CachePayload<T> | null> {
  const memoryCache = memoryCacheByCategory[category] as
    | CachePayload<T>
    | undefined;
  if (memoryCache) return memoryCache;
  const cachePath = getCachePath(category);
  const exists = await RNFS.exists(cachePath);
  if (!exists) return null;

  const raw = await RNFS.readFile(cachePath, 'utf8');
  const parsed = JSON.parse(raw) as CachePayload<T>;
  memoryCacheByCategory[category] = parsed as CachePayload<ModelMetaBase>;
  return parsed;
}

async function saveCache<T extends ModelMetaBase>(
  category: ModelCategory,
  payload: CachePayload<T>
): Promise<void> {
  const cacheDir = getCacheDir();
  await RNFS.mkdir(cacheDir);
  await RNFS.writeFile(getCachePath(category), JSON.stringify(payload), 'utf8');
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
  }
): Promise<T[]> {
  const ttl = options?.cacheTtlMinutes ?? CACHE_TTL_MINUTES;
  const cached = await loadCacheFromDisk<T>(category);

  if (!options?.forceRefresh && cached && isCacheFresh(cached, ttl)) {
    return cached.models;
  }

  const response = await fetch(getReleaseUrl(category));
  if (!response.ok) {
    if (cached) return cached.models;
    throw new Error(`Failed to fetch models: ${response.status}`);
  }

  const body = await response.json();
  const assets = Array.isArray(body?.assets) ? body.assets : [];
  const models: T[] = assets
    .map((asset: any) =>
      toModelMeta(category, {
        name: asset.name,
        size: asset.size,
        browser_download_url: asset.browser_download_url,
      })
    )
    .filter((model: ModelMetaBase | null): model is T => Boolean(model));

  const payload: CachePayload<T> = {
    lastUpdated: new Date().toISOString(),
    models,
  };
  await saveCache(category, payload);
  return models;
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

export async function listDownloadedModelsByCategory<T extends ModelMetaBase>(
  category: ModelCategory
): Promise<T[]> {
  const baseDir = getModelsBaseDir(category);
  const exists = await RNFS.exists(baseDir);
  if (!exists) return [];

  const entries = await RNFS.readDir(baseDir);
  const models: T[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = getManifestPath(category, entry.name);
    const manifestExists = await RNFS.exists(manifestPath);
    if (manifestExists) {
      try {
        const raw = await RNFS.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw) as { model?: T };
        if (manifest.model) {
          models.push(manifest.model);
          continue;
        }
      } catch {
        // ignore and fall back
      }
    }

    const model = await getModelByIdByCategory<T>(category, entry.name);
    if (model) {
      models.push(model);
    }
  }

  return models;
}

export async function isModelDownloadedByCategory(
  category: ModelCategory,
  id: string
): Promise<boolean> {
  const readyPath = getReadyMarkerPath(category, id);
  return RNFS.exists(readyPath);
}

export async function getLocalModelPathByCategory(
  category: ModelCategory,
  id: string
): Promise<string | null> {
  const ready = await isModelDownloadedByCategory(category, id);
  if (!ready) return null;
  return getModelDir(category, id);
}

export async function downloadModelByCategory<T extends ModelMetaBase>(
  category: ModelCategory,
  id: string,
  opts?: {
    onProgress?: (progress: DownloadProgress) => void;
    overwrite?: boolean;
    signal?: AbortSignal;
    maxRetries?: number;
  }
): Promise<DownloadResult> {
  const model = await getModelByIdByCategory<T>(category, id);
  if (!model) {
    throw new Error(`Unknown model id: ${id}`);
  }

  const baseDir = getModelsBaseDir(category);
  await RNFS.mkdir(baseDir);

  const archivePath = getArchivePath(category, id);
  const modelDir = getModelDir(category, id);

  if (opts?.overwrite) {
    if (await RNFS.exists(modelDir)) {
      await RNFS.unlink(modelDir);
    }
    if (await RNFS.exists(archivePath)) {
      await RNFS.unlink(archivePath);
    }
  }

  if (!(await RNFS.exists(archivePath))) {
    const download = RNFS.downloadFile({
      fromUrl: model.downloadUrl,
      toFile: archivePath,
      progressDivider: 1,
      progress: (data) => {
        const total = data.contentLength || model.bytes || 0;
        const percent = total > 0 ? (data.bytesWritten / total) * 100 : 0;
        opts?.onProgress?.({
          bytesDownloaded: data.bytesWritten,
          totalBytes: total,
          percent,
        });
      },
    });

    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => {
        RNFS.stopDownload(download.jobId);
      });
    }

    const result = await download.promise;
    if (result.statusCode && result.statusCode >= 400) {
      throw new Error(`Download failed: ${result.statusCode}`);
    }
  }

  await RNFS.mkdir(modelDir);
  await extractTarBz2(archivePath, modelDir, true, (evt) => {
    if (model.bytes > 0) {
      opts?.onProgress?.({
        bytesDownloaded: evt.bytes,
        totalBytes: evt.totalBytes,
        percent: evt.percent,
      });
    }
  });

  await RNFS.writeFile(getReadyMarkerPath(category, id), 'ready', 'utf8');
  await RNFS.writeFile(
    getManifestPath(category, id),
    JSON.stringify({
      downloadedAt: new Date().toISOString(),
      model,
    }),
    'utf8'
  );

  return { modelId: id, localPath: modelDir };
}

export async function deleteModelByCategory(
  category: ModelCategory,
  id: string
): Promise<void> {
  const modelDir = getModelDir(category, id);
  const archivePath = getArchivePath(category, id);
  if (await RNFS.exists(modelDir)) {
    await RNFS.unlink(modelDir);
  }
  if (await RNFS.exists(archivePath)) {
    await RNFS.unlink(archivePath);
  }
}

export async function clearModelCacheByCategory(
  category: ModelCategory
): Promise<void> {
  const cachePath = getCachePath(category);
  if (await RNFS.exists(cachePath)) {
    await RNFS.unlink(cachePath);
  }
  delete memoryCacheByCategory[category];
}

export async function getDownloadStorageBase(): Promise<string> {
  if (Platform.OS === 'ios') {
    return RNFS.DocumentDirectoryPath;
  }
  return RNFS.DocumentDirectoryPath;
}
