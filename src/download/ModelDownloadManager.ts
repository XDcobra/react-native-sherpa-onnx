import { Alert, Platform } from 'react-native';
import RNFS from 'react-native-fs';
import { extractTarBz2 } from './extractTarBz2';
import {
  parseChecksumFile,
  validateChecksum,
  validateExtractedFiles,
  checkDiskSpace,
} from './validation';

const RELEASE_API_BASE =
  'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags';
const CACHE_TTL_MINUTES = 24 * 60;
const MODEL_ARCHIVE_EXT = '.tar.bz2';
const MODEL_ONNX_EXT = '.onnx';

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

type ModelArchiveExt = 'tar.bz2' | 'onnx';

export type ModelMetaBase = {
  id: string;
  displayName: string;
  downloadUrl: string;
  archiveExt: ModelArchiveExt;
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
  phase?: 'downloading' | 'extracting';
  speed?: number; // bytes per second
  eta?: number; // estimated seconds remaining
};

export type DownloadResult = {
  modelId: string;
  localPath: string;
};

export type DownloadProgressListener = (
  category: ModelCategory,
  modelId: string,
  progress: DownloadProgress
) => void;

export type ModelsListUpdatedListener = (
  category: ModelCategory,
  models: ModelMetaBase[]
) => void;

type ModelManifest<T extends ModelMetaBase = ModelMetaBase> = {
  downloadedAt: string;
  lastUsed?: string;
  model: T;
};

export type ModelWithMetadata<T extends ModelMetaBase = ModelMetaBase> = {
  model: T;
  downloadedAt: string;
  lastUsed: string | null;
  sizeOnDisk?: number;
};

type ChecksumIssue = {
  category: ModelCategory;
  id: string;
  archivePath: string;
  expected?: string;
  message: string;
  reason: 'CHECKSUM_FAILED' | 'CHECKSUM_MISMATCH';
};

const promptChecksumFallback = (issue: ChecksumIssue): Promise<boolean> =>
  new Promise((resolve) => {
    const reasonText =
      issue.reason === 'CHECKSUM_FAILED'
        ? 'Failed to compute checksum.'
        : 'Computed checksum does not match the expected value.';
    const body = `${reasonText}\n\n${issue.message}\n\nDo you want to keep the file and continue?`;

    Alert.alert('Checksum Problem', body, [
      {
        text: 'Delete and cancel',
        style: 'destructive',
        onPress: () => resolve(false),
      },
      {
        text: 'Keep file',
        style: 'default',
        onPress: () => resolve(true),
      },
    ]);
  });

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

const checksumCacheByCategory: Partial<
  Record<ModelCategory, Map<string, string>>
> = {};

const downloadProgressListeners = new Set<DownloadProgressListener>();
const modelsListUpdatedListeners = new Set<ModelsListUpdatedListener>();

export const subscribeDownloadProgress = (
  listener: DownloadProgressListener
): (() => void) => {
  downloadProgressListeners.add(listener);
  return () => {
    downloadProgressListeners.delete(listener);
  };
};

const emitDownloadProgress = (
  category: ModelCategory,
  modelId: string,
  progress: DownloadProgress
) => {
  for (const listener of downloadProgressListeners) {
    try {
      listener(category, modelId, progress);
    } catch (error) {
      console.warn('Download progress listener error:', error);
    }
  }
};

export const subscribeModelsListUpdated = (
  listener: ModelsListUpdatedListener
): (() => void) => {
  modelsListUpdatedListeners.add(listener);
  return () => {
    modelsListUpdatedListeners.delete(listener);
  };
};

const emitModelsListUpdated = (
  category: ModelCategory,
  models: ModelMetaBase[]
) => {
  for (const listener of modelsListUpdatedListeners) {
    try {
      listener(category, models);
    } catch (error) {
      console.warn('Models list listener error:', error);
    }
  }
};

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
    tag: 'asr-models',
    cacheFile: 'vad-models.json',
    baseDir: `${RNFS.DocumentDirectoryPath}/sherpa-onnx/models/vad`,
  },
  [ModelCategory.Diarization]: {
    tag: 'speaker-segmentation-models',
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

function getArchiveFilename(
  modelId: string,
  archiveExt: ModelArchiveExt
): string {
  return `${modelId}.${archiveExt}`;
}

function getArchivePath(
  category: ModelCategory,
  modelId: string,
  archiveExt: ModelArchiveExt
): string {
  const filename = getArchiveFilename(modelId, archiveExt);
  if (archiveExt === 'onnx') {
    return `${getModelDir(category, modelId)}/${filename}`;
  }
  return `${getModelsBaseDir(category)}/${filename}`;
}

function getTarArchivePath(category: ModelCategory, modelId: string): string {
  return getArchivePath(category, modelId, 'tar.bz2');
}

function getOnnxPath(category: ModelCategory, modelId: string): string {
  return getArchivePath(category, modelId, 'onnx');
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

/**
 * Retry helper with exponential backoff
 * @param fn - The async function to retry
 * @param options - Retry configuration
 * @returns The result of the function
 * @throws The last error if all retries fail or AbortError if aborted
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 10000;
  const backoffFactor = options.backoffFactor ?? 2;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) {
      const abortError = new Error('Operation aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on abort
      if (lastError.name === 'AbortError' || options.signal?.aborted) {
        throw lastError;
      }

      // If this was the last attempt, throw the error
      if (attempt === maxRetries) {
        throw lastError;
      }

      // Calculate delay with exponential backoff
      const delayMs = Math.min(
        initialDelayMs * Math.pow(backoffFactor, attempt),
        maxDelayMs
      );

      console.warn(
        `Retry attempt ${attempt + 1}/${maxRetries} after ${delayMs}ms due to:`,
        lastError.message
      );

      // Wait before retrying
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError ?? new Error('Retry failed with no error');
}

async function fetchChecksumsFromRelease(
  category: ModelCategory
): Promise<Map<string, string>> {
  // Return cached if available
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
  if (archiveExt !== 'tar.bz2') {
    return null;
  }

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
      .map((asset: any) =>
        toModelMeta(category, {
          name: asset.name,
          size: asset.size,
          browser_download_url: asset.browser_download_url,
          digest: asset.digest,
        })
      )
      .filter((model: ModelMetaBase | null): model is T => Boolean(model));

    // Load and attach SHA256 checksums from checksum.txt
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
    // If retry failed and we have cached data, return it as fallback
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
        const manifest = JSON.parse(raw) as ModelManifest<T>;
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

  // Update lastUsed timestamp when model is accessed
  await updateModelLastUsed(category, id);

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
    onChecksumIssue?: (issue: ChecksumIssue) => Promise<boolean>;
  }
): Promise<DownloadResult> {
  const isAborted = () => Boolean(opts?.signal?.aborted);

  if (opts?.signal?.aborted) {
    const abortError = new Error('Download aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }

  const model = await getModelByIdByCategory<T>(category, id);
  if (!model) {
    throw new Error(`Unknown model id: ${id}`);
  }

  const baseDir = getModelsBaseDir(category);
  await RNFS.mkdir(baseDir);

  const downloadPath = getArchivePath(category, id, model.archiveExt);
  const isArchive = model.archiveExt === 'tar.bz2';
  const modelDir = getModelDir(category, id);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  const cleanupPartial = async () => {
    if (!isArchive) {
      return;
    }

    // Only clean up extracted model dir, preserve archive for download resume
    if (await RNFS.exists(modelDir)) {
      await RNFS.unlink(modelDir);
    }
  };

  const cleanupPartialWithRetry = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await cleanupPartial();
      if (!(await RNFS.exists(modelDir))) {
        return;
      }
      await sleep(400);
    }

    if (await RNFS.exists(modelDir)) {
      console.warn(
        `Model cleanup after abort did not fully complete for ${category}:${id}`
      );
    }
  };

  // Step 1: Check available disk space
  const diskSpaceCheck = await checkDiskSpace(model.bytes);
  if (!diskSpaceCheck.success) {
    throw new Error(`Insufficient disk space: ${diskSpaceCheck.message}`);
  }

  if (opts?.overwrite) {
    if (await RNFS.exists(modelDir)) {
      await RNFS.unlink(modelDir);
    }
    if (await RNFS.exists(downloadPath)) {
      await RNFS.unlink(downloadPath);
    }
  } else {
    // Clean up incomplete extractions but preserve partial downloads for resume
    const readyMarkerExists = await RNFS.exists(
      getReadyMarkerPath(category, id)
    );
    if (!readyMarkerExists) {
      if (isArchive) {
        // No ready marker found; only clean up extracted model dir
        // Keep archive file to support download resume
        if (await RNFS.exists(modelDir)) {
          // Removing partial model dir
          await RNFS.unlink(modelDir);
        }
      }
    }
  }

  try {
    // Step 2: Download archive or onnx file (with resume support)
    if (!isArchive) {
      await RNFS.mkdir(modelDir);
    }

    const archiveExists = await RNFS.exists(downloadPath);
    let partialDownload = false;

    if (archiveExists) {
      // Check if this is a complete download or partial
      const stat = await RNFS.stat(downloadPath);
      const currentSize = stat.size;
      if (currentSize < model.bytes) {
        partialDownload = true;
        console.log(
          `[Download] Resuming partial download for ${category}:${id} (${currentSize}/${model.bytes} bytes)`
        );
      }
    }

    if (!archiveExists || partialDownload) {
      const maxRetries = opts?.maxRetries ?? 2;

      await retryWithBackoff(
        async () => {
          const downloadStartTime = Date.now();

          const download = RNFS.downloadFile({
            fromUrl: model.downloadUrl,
            toFile: downloadPath,
            progressDivider: 1,
            resumable: () => {
              // iOS only: Called when download is resumed
              console.log(`[Download] Resuming download for ${category}:${id}`);
            },
            progress: (data) => {
              if (isAborted()) {
                return;
              }
              const total = data.contentLength || model.bytes || 0;
              const percent = total > 0 ? (data.bytesWritten / total) * 100 : 0;

              // Calculate speed and ETA
              const now = Date.now();
              const elapsedSeconds = (now - downloadStartTime) / 1000;

              let speed: number | undefined;
              let eta: number | undefined;

              if (elapsedSeconds > 0.5) {
                // Calculate overall speed (bytes per second)
                speed = data.bytesWritten / elapsedSeconds;

                // Calculate ETA based on current speed
                const remainingBytes = total - data.bytesWritten;
                if (speed > 0) {
                  eta = remainingBytes / speed;
                }
              }

              const progress: DownloadProgress = {
                bytesDownloaded: data.bytesWritten,
                totalBytes: total,
                percent,
                phase: 'downloading',
                speed,
                eta,
              };
              opts?.onProgress?.(progress);
              emitDownloadProgress(category, id, progress);
            },
          });

          let downloadFinished = false;
          let aborted = false;
          const onAbort = () => {
            aborted = true;
            if (downloadFinished) return;
            try {
              RNFS.stopDownload(download.jobId);
            } catch {
              // Swallow stop errors to avoid crashing the app on cancel.
            }
          };

          if (opts?.signal) {
            opts.signal.addEventListener('abort', onAbort);
          }

          let result: any;
          try {
            result = await download.promise;
          } finally {
            downloadFinished = true;
            if (opts?.signal) {
              opts.signal.removeEventListener('abort', onAbort);
            }
          }
          if (aborted || opts?.signal?.aborted) {
            const abortError = new Error('Download aborted');
            abortError.name = 'AbortError';
            throw abortError;
          }
          if (result.statusCode && result.statusCode >= 400) {
            // For certain errors, delete partial download as resume won't help
            const isNonResumableError =
              result.statusCode === 404 || // Not found
              result.statusCode === 410 || // Gone
              result.statusCode === 451 || // Unavailable for legal reasons
              result.statusCode === 416; // Range not satisfiable
            if (isNonResumableError && (await RNFS.exists(downloadPath))) {
              console.warn(
                `[Download] Non-resumable error ${result.statusCode}, removing partial download`
              );
              await RNFS.unlink(downloadPath);
            }
            throw new Error(`Download failed: ${result.statusCode}`);
          }
        },
        {
          maxRetries,
          initialDelayMs: 2000,
          signal: opts?.signal,
        }
      );
    }

    if (opts?.signal?.aborted) {
      const abortError = new Error('Download aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }

    let extractResult: { sha256?: string } | null = null;

    if (isArchive) {
      await RNFS.mkdir(modelDir);
      const extractStartTime = Date.now();
      extractResult = await extractTarBz2(
        downloadPath,
        modelDir,
        true,
        (evt) => {
          if (isAborted()) {
            return;
          }
          if (model.bytes > 0) {
            // Calculate extraction speed and ETA
            const now = Date.now();
            const elapsedSeconds = (now - extractStartTime) / 1000;

            let speed: number | undefined;
            let eta: number | undefined;

            if (elapsedSeconds > 0.5) {
              speed = evt.bytes / elapsedSeconds;
              const remainingBytes = evt.totalBytes - evt.bytes;
              if (speed > 0) {
                eta = remainingBytes / speed;
              }
            }

            const progress: DownloadProgress = {
              bytesDownloaded: evt.bytes,
              totalBytes: evt.totalBytes,
              percent: evt.percent,
              phase: 'extracting',
              speed,
              eta,
            };
            opts?.onProgress?.(progress);
            emitDownloadProgress(category, id, progress);
          }
        },
        opts?.signal
      );
    }

    // Step 3: Validate checksum if available
    if (model.sha256) {
      const expectedSha = model.sha256.toLowerCase();
      let issue: ChecksumIssue | null = null;

      if (isArchive) {
        const nativeSha = extractResult?.sha256?.toLowerCase();
        if (!nativeSha) {
          issue = {
            category,
            id,
            archivePath: downloadPath,
            expected: model.sha256,
            message: 'Native SHA-256 not available after extraction.',
            reason: 'CHECKSUM_FAILED',
          };
        } else if (nativeSha !== expectedSha) {
          issue = {
            category,
            id,
            archivePath: downloadPath,
            expected: model.sha256,
            message: `Checksum mismatch: expected ${model.sha256}, got ${extractResult?.sha256}`,
            reason: 'CHECKSUM_MISMATCH',
          };
        }
      } else {
        const checksumResult = await validateChecksum(
          downloadPath,
          expectedSha
        );
        if (!checksumResult.success) {
          issue = {
            category,
            id,
            archivePath: downloadPath,
            expected: model.sha256,
            message: checksumResult.message ?? 'Checksum validation failed.',
            reason:
              checksumResult.error === 'CHECKSUM_MISMATCH'
                ? 'CHECKSUM_MISMATCH'
                : 'CHECKSUM_FAILED',
          };
        }
      }

      if (issue) {
        const keepFile = opts?.onChecksumIssue
          ? await opts.onChecksumIssue(issue)
          : await promptChecksumFallback(issue);

        if (!keepFile) {
          if (await RNFS.exists(modelDir)) {
            await RNFS.unlink(modelDir);
          }
          if (await RNFS.exists(downloadPath)) {
            await RNFS.unlink(downloadPath);
          }
          throw new Error(`Checksum validation failed: ${issue.message}`);
        }
      }
    }

    if (opts?.signal?.aborted) {
      const abortError = new Error('Download aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }

    // Step 4: Validate extracted files exist
    const filesValidation = await validateExtractedFiles(modelDir, category);
    if (!filesValidation.success) {
      // Clean up failed extraction
      await RNFS.unlink(modelDir);
      throw new Error(
        `Extracted files validation failed: ${filesValidation.message}`
      );
    }

    await RNFS.writeFile(getReadyMarkerPath(category, id), 'ready', 'utf8');
    const now = new Date().toISOString();
    await RNFS.writeFile(
      getManifestPath(category, id),
      JSON.stringify({
        downloadedAt: now,
        lastUsed: now,
        model,
      } as ModelManifest),
      'utf8'
    );

    return { modelId: id, localPath: modelDir };
  } catch (err) {
    if ((err instanceof Error && err.name === 'AbortError') || isAborted()) {
      await cleanupPartialWithRetry();
    }
    throw err;
  }
}

/**
 * Update the lastUsed timestamp for a downloaded model
 */
export async function updateModelLastUsed(
  category: ModelCategory,
  id: string
): Promise<void> {
  const manifestPath = getManifestPath(category, id);
  const exists = await RNFS.exists(manifestPath);
  if (!exists) return;

  try {
    const raw = await RNFS.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as ModelManifest;
    manifest.lastUsed = new Date().toISOString();
    await RNFS.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  } catch (error) {
    console.warn(`Failed to update lastUsed for ${category}:${id}:`, error);
  }
}

/**
 * Get all downloaded models with LRU metadata
 */
export async function listDownloadedModelsWithMetadata<T extends ModelMetaBase>(
  category: ModelCategory
): Promise<ModelWithMetadata<T>[]> {
  const baseDir = getModelsBaseDir(category);
  const exists = await RNFS.exists(baseDir);
  if (!exists) return [];

  const entries = await RNFS.readDir(baseDir);
  const modelsWithMetadata: ModelWithMetadata<T>[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = getManifestPath(category, entry.name);
    const manifestExists = await RNFS.exists(manifestPath);

    if (manifestExists) {
      try {
        const raw = await RNFS.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw) as ModelManifest<T>;
        if (manifest.model) {
          modelsWithMetadata.push({
            model: manifest.model,
            downloadedAt: manifest.downloadedAt,
            lastUsed: manifest.lastUsed ?? null,
            sizeOnDisk: entry.size,
          });
        }
      } catch (error) {
        console.warn(
          `Failed to read manifest for ${category}:${entry.name}:`,
          error
        );
      }
    }
  }

  return modelsWithMetadata;
}

/**
 * Remove least recently used models to free up disk space
 * @param category - Model category
 * @param targetBytes - Target amount of bytes to free (optional)
 * @param maxModelsToDelete - Maximum number of models to delete (default: no limit)
 * @returns Array of deleted model IDs
 */
export async function cleanupLeastRecentlyUsed(
  category: ModelCategory,
  options?: {
    targetBytes?: number;
    maxModelsToDelete?: number;
    keepCount?: number;
  }
): Promise<string[]> {
  const modelsWithMetadata = await listDownloadedModelsWithMetadata(category);

  if (modelsWithMetadata.length === 0) {
    return [];
  }

  // Keep at least this many models
  const keepCount = options?.keepCount ?? 1;
  if (modelsWithMetadata.length <= keepCount) {
    return [];
  }

  // Sort by lastUsed (oldest first), then by downloadedAt if no lastUsed
  const sorted = modelsWithMetadata.sort((a, b) => {
    const aTime = a.lastUsed ?? a.downloadedAt;
    const bTime = b.lastUsed ?? b.downloadedAt;
    return new Date(aTime).getTime() - new Date(bTime).getTime();
  });

  const deletedIds: string[] = [];
  let bytesFreed = 0;
  const targetBytes = options?.targetBytes ?? 0;
  const maxToDelete = options?.maxModelsToDelete ?? sorted.length - keepCount;

  for (let i = 0; i < sorted.length - keepCount && i < maxToDelete; i++) {
    const item = sorted[i];
    if (!item) continue;

    try {
      await deleteModelByCategory(category, item.model.id);
      deletedIds.push(item.model.id);
      bytesFreed += item.sizeOnDisk ?? 0;

      console.log(
        `[LRU Cleanup] Deleted ${category}:${item.model.id} (freed ${
          (item.sizeOnDisk ?? 0) / 1024 / 1024
        } MB)`
      );

      if (targetBytes > 0 && bytesFreed >= targetBytes) {
        break;
      }
    } catch (error) {
      console.warn(
        `[LRU Cleanup] Failed to delete ${category}:${item.model.id}:`,
        error
      );
    }
  }

  return deletedIds;
}

export async function deleteModelByCategory(
  category: ModelCategory,
  id: string
): Promise<void> {
  const modelDir = getModelDir(category, id);
  const tarPath = getTarArchivePath(category, id);
  const onnxPath = getOnnxPath(category, id);
  if (await RNFS.exists(modelDir)) {
    await RNFS.unlink(modelDir);
  }
  if (await RNFS.exists(tarPath)) {
    await RNFS.unlink(tarPath);
  }
  if (await RNFS.exists(onnxPath)) {
    await RNFS.unlink(onnxPath);
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
