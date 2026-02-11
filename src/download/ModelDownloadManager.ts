import { Platform } from 'react-native';
import RNFS from 'react-native-fs';
import { extractTarBz2 } from './extractTarBz2';

const RELEASE_API_URL =
  'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/tts-models';
const CACHE_TTL_MINUTES = 24 * 60;
const MODEL_ARCHIVE_EXT = '.tar.bz2';

export type TtsModelType =
  | 'vits'
  | 'kokoro'
  | 'matcha'
  | 'kitten'
  | 'zipvoice'
  | 'unknown';

export type Quantization = 'fp16' | 'int8' | 'int8-quantized' | 'unknown';

export type SizeTier = 'tiny' | 'small' | 'medium' | 'large' | 'unknown';

export type TtsModelMeta = {
  id: string;
  displayName: string;
  type: TtsModelType;
  languages: string[];
  quantization: Quantization;
  sizeTier: SizeTier;
  downloadUrl: string;
  archiveExt: 'tar.bz2';
  bytes: number;
  sha256?: string;
};

export type FilterOptions = {
  language?: string;
  type?: string;
  quantization?: string;
  sizeTier?: string;
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

type CachePayload = {
  lastUpdated: string;
  models: TtsModelMeta[];
};

type CacheStatus = {
  lastUpdated: string | null;
  source: 'cache' | 'remote';
};

let memoryCache: CachePayload | null = null;

function normalizeFilter(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'any') return null;
  return trimmed.toLowerCase();
}

function getCacheDir(): string {
  return `${RNFS.DocumentDirectoryPath}/sherpa-onnx/cache`;
}

function getCachePath(): string {
  return `${getCacheDir()}/tts-models.json`;
}

function getModelsBaseDir(): string {
  return `${RNFS.DocumentDirectoryPath}/sherpa-onnx/models/tts`;
}

function getModelDir(modelId: string): string {
  return `${getModelsBaseDir()}/${modelId}`;
}

function getArchivePath(modelId: string): string {
  return `${getModelsBaseDir()}/${modelId}${MODEL_ARCHIVE_EXT}`;
}

function getReadyMarkerPath(modelId: string): string {
  return `${getModelDir(modelId)}/.ready`;
}

function getManifestPath(modelId: string): string {
  return `${getModelDir(modelId)}/manifest.json`;
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

function toModelMeta(asset: {
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
  };
}

async function loadCacheFromDisk(): Promise<CachePayload | null> {
  if (memoryCache) return memoryCache;
  const cachePath = getCachePath();
  const exists = await RNFS.exists(cachePath);
  if (!exists) return null;

  const raw = await RNFS.readFile(cachePath, 'utf8');
  const parsed = JSON.parse(raw) as CachePayload;
  memoryCache = parsed;
  return parsed;
}

async function saveCache(payload: CachePayload): Promise<void> {
  const cacheDir = getCacheDir();
  await RNFS.mkdir(cacheDir);
  await RNFS.writeFile(getCachePath(), JSON.stringify(payload), 'utf8');
  memoryCache = payload;
}

function isCacheFresh(payload: CachePayload, ttlMinutes: number): boolean {
  const updated = new Date(payload.lastUpdated).getTime();
  if (!updated) return false;
  const ageMs = Date.now() - updated;
  return ageMs < ttlMinutes * 60 * 1000;
}

export async function listTtsModels(): Promise<TtsModelMeta[]> {
  const cache = await loadCacheFromDisk();
  return cache?.models ?? [];
}

export async function refreshTtsModels(options?: {
  forceRefresh?: boolean;
  cacheTtlMinutes?: number;
}): Promise<TtsModelMeta[]> {
  const ttl = options?.cacheTtlMinutes ?? CACHE_TTL_MINUTES;
  const cached = await loadCacheFromDisk();

  if (!options?.forceRefresh && cached && isCacheFresh(cached, ttl)) {
    return cached.models;
  }

  const response = await fetch(RELEASE_API_URL);
  if (!response.ok) {
    if (cached) return cached.models;
    throw new Error(`Failed to fetch models: ${response.status}`);
  }

  const body = await response.json();
  const assets = Array.isArray(body?.assets) ? body.assets : [];
  const models: TtsModelMeta[] = assets
    .map((asset: any) =>
      toModelMeta({
        name: asset.name,
        size: asset.size,
        browser_download_url: asset.browser_download_url,
      })
    )
    .filter((model: TtsModelMeta | null): model is TtsModelMeta =>
      Boolean(model)
    );

  const payload: CachePayload = {
    lastUpdated: new Date().toISOString(),
    models,
  };
  await saveCache(payload);
  return models;
}

export async function getTtsModelsCacheStatus(): Promise<CacheStatus> {
  const cached = await loadCacheFromDisk();
  if (!cached) {
    return { lastUpdated: null, source: 'cache' };
  }
  return { lastUpdated: cached.lastUpdated, source: 'cache' };
}

export async function filterTtsModels(
  options: FilterOptions
): Promise<TtsModelMeta[]> {
  const models = await listTtsModels();
  const language = normalizeFilter(options.language);
  const type = normalizeFilter(options.type);
  const quantization = normalizeFilter(options.quantization);
  const sizeTier = normalizeFilter(options.sizeTier);

  return models.filter((model) => {
    if (type && model.type !== type) return false;
    if (quantization && model.quantization !== quantization) return false;
    if (sizeTier && model.sizeTier !== sizeTier) return false;
    if (
      language &&
      !model.languages.map((l) => l.toLowerCase()).includes(language)
    ) {
      return false;
    }
    return true;
  });
}

export async function getTtsModelById(
  id: string
): Promise<TtsModelMeta | null> {
  const models = await listTtsModels();
  return models.find((model) => model.id === id) ?? null;
}

export async function listDownloadedTtsModels(): Promise<TtsModelMeta[]> {
  const baseDir = getModelsBaseDir();
  const exists = await RNFS.exists(baseDir);
  if (!exists) return [];

  const entries = await RNFS.readDir(baseDir);
  const models: TtsModelMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = getManifestPath(entry.name);
    const manifestExists = await RNFS.exists(manifestPath);
    if (manifestExists) {
      try {
        const raw = await RNFS.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw) as { model?: TtsModelMeta };
        if (manifest.model) {
          models.push(manifest.model);
          continue;
        }
      } catch {
        // ignore and fall back
      }
    }

    const model = await getTtsModelById(entry.name);
    if (model) {
      models.push(model);
    }
  }

  return models;
}

export async function isModelDownloaded(id: string): Promise<boolean> {
  const readyPath = getReadyMarkerPath(id);
  return RNFS.exists(readyPath);
}

export async function getLocalModelPath(id: string): Promise<string | null> {
  const ready = await isModelDownloaded(id);
  if (!ready) return null;
  return getModelDir(id);
}

export async function downloadTtsModel(
  id: string,
  opts?: {
    onProgress?: (progress: DownloadProgress) => void;
    overwrite?: boolean;
    signal?: AbortSignal;
    maxRetries?: number;
  }
): Promise<DownloadResult> {
  const model = await getTtsModelById(id);
  if (!model) {
    throw new Error(`Unknown model id: ${id}`);
  }

  const baseDir = getModelsBaseDir();
  await RNFS.mkdir(baseDir);

  const archivePath = getArchivePath(id);
  const modelDir = getModelDir(id);

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

  await RNFS.writeFile(getReadyMarkerPath(id), 'ready', 'utf8');
  await RNFS.writeFile(
    getManifestPath(id),
    JSON.stringify({
      downloadedAt: new Date().toISOString(),
      model,
    }),
    'utf8'
  );

  return { modelId: id, localPath: modelDir };
}

export async function deleteTtsModel(id: string): Promise<void> {
  const modelDir = getModelDir(id);
  const archivePath = getArchivePath(id);
  if (await RNFS.exists(modelDir)) {
    await RNFS.unlink(modelDir);
  }
  if (await RNFS.exists(archivePath)) {
    await RNFS.unlink(archivePath);
  }
}

export async function clearModelCache(): Promise<void> {
  const cachePath = getCachePath();
  if (await RNFS.exists(cachePath)) {
    await RNFS.unlink(cachePath);
  }
  memoryCache = null;
}

export async function getDownloadStorageBase(): Promise<string> {
  if (Platform.OS === 'ios') {
    return RNFS.DocumentDirectoryPath;
  }
  return RNFS.DocumentDirectoryPath;
}
