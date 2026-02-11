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
  phase?: 'downloading' | 'extracting' | 'validating';
};

export type DownloadResult = {
  modelId: string;
  localPath: string;
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

async function fetchChecksumsFromRelease(
  category: ModelCategory
): Promise<Map<string, string>> {
  // Return cached if available
  if (checksumCacheByCategory[category]) {
    return checksumCacheByCategory[category]!;
  }

  try {
    const response = await fetch(
      `https://github.com/k2-fsa/sherpa-onnx/releases/download/${CATEGORY_CONFIG[category].tag}/checksum.txt`
    );

    if (!response.ok) {
      console.warn(
        `SherpaOnnxChecksum: Failed to fetch checksum.txt for ${category}: ${response.status}`
      );
      return new Map();
    }

    const content = await response.text();
    const checksums = parseChecksumFile(content);
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

  // Load and attach SHA256 checksums from checksum.txt
  const checksums = await fetchChecksumsFromRelease(category);
  for (const model of models) {
    const archiveFilename = `${model.id}${MODEL_ARCHIVE_EXT}`;
    const sha256 = checksums.get(archiveFilename);
    if (sha256) {
      model.sha256 = sha256;
    }
  }

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

  const archivePath = getArchivePath(category, id);
  const modelDir = getModelDir(category, id);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  const cleanupPartial = async () => {
    if (await RNFS.exists(modelDir)) {
      await RNFS.unlink(modelDir);
    }
    if (await RNFS.exists(archivePath)) {
      await RNFS.unlink(archivePath);
    }
  };

  const cleanupPartialWithRetry = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await cleanupPartial();
      if (!(await RNFS.exists(modelDir)) && !(await RNFS.exists(archivePath))) {
        return;
      }
      await sleep(400);
    }

    if ((await RNFS.exists(modelDir)) || (await RNFS.exists(archivePath))) {
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
    if (await RNFS.exists(archivePath)) {
      await RNFS.unlink(archivePath);
    }
  } else {
    // Clean up incomplete downloads from previous aborted attempts
    const readyMarkerExists = await RNFS.exists(
      getReadyMarkerPath(category, id)
    );
    if (!readyMarkerExists) {
      // No ready marker found; cleaning up partial files
      if (await RNFS.exists(archivePath)) {
        // Found partial archive; will delete
        await RNFS.unlink(archivePath);
        // Deleted archive. stillExists: ${stillExists}
      }
      if (await RNFS.exists(modelDir)) {
        // Removing partial model dir
        await RNFS.unlink(modelDir);
      }
    }
  }

  try {
    // Step 2: Download archive if not exists
    const archiveExists = await RNFS.exists(archivePath);
    // Archive existence check for ${archivePath}: ${archiveExists}
    if (!archiveExists) {
      // Starting download for ${category}:${id} from ${model.downloadUrl}
      const download = RNFS.downloadFile({
        fromUrl: model.downloadUrl,
        toFile: archivePath,
        progressDivider: 1,
        progress: (data) => {
          if (isAborted()) {
            return;
          }
          const total = data.contentLength || model.bytes || 0;
          const percent = total > 0 ? (data.bytesWritten / total) * 100 : 0;
          opts?.onProgress?.({
            bytesDownloaded: data.bytesWritten,
            totalBytes: total,
            percent,
            phase: 'downloading',
          });
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
        throw new Error(`Download failed: ${result.statusCode}`);
      }

      // Step 3: Validate checksum if available
      if (model.sha256) {
        const checksumValidation = await validateChecksum(
          archivePath,
          model.sha256,
          (bytesProcessed, totalBytes, percent) => {
            if (isAborted()) {
              return;
            }
            opts?.onProgress?.({
              bytesDownloaded: bytesProcessed,
              totalBytes,
              percent,
              phase: 'validating',
            });
          }
        );
        if (!checksumValidation.success) {
          const issue: ChecksumIssue = {
            category,
            id,
            archivePath,
            expected: model.sha256,
            message:
              checksumValidation.message ?? 'Checksum validation failed.',
            reason:
              checksumValidation.error === 'CHECKSUM_FAILED'
                ? 'CHECKSUM_FAILED'
                : 'CHECKSUM_MISMATCH',
          };

          const keepFile = opts?.onChecksumIssue
            ? await opts.onChecksumIssue(issue)
            : await promptChecksumFallback(issue);

          if (!keepFile) {
            await RNFS.unlink(archivePath);
            throw new Error(
              `Checksum validation failed: ${checksumValidation.message}`
            );
          }
        }
      }
    }

    if (opts?.signal?.aborted) {
      const abortError = new Error('Download aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }

    await RNFS.mkdir(modelDir);
    await extractTarBz2(
      archivePath,
      modelDir,
      true,
      (evt) => {
        if (isAborted()) {
          return;
        }
        if (model.bytes > 0) {
          opts?.onProgress?.({
            bytesDownloaded: evt.bytes,
            totalBytes: evt.totalBytes,
            percent: evt.percent,
            phase: 'extracting',
          });
        }
      },
      opts?.signal
    );

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
    await RNFS.writeFile(
      getManifestPath(category, id),
      JSON.stringify({
        downloadedAt: new Date().toISOString(),
        model,
      }),
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
