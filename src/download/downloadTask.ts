import {
  completeHandler,
  createDownloadTask,
  getExistingDownloadTasks,
  setConfig,
} from '@kesha-antonov/react-native-background-downloader';
import {
  exists,
  mkdir,
  moveFile,
  readDir,
  readFile,
  stat,
  unlink,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import { Platform } from 'react-native';
import { makeModelOperationKey } from './activeModelOperations';
import type {
  BackgroundDownloaderSetConfigOptions,
  DownloadTask,
} from './background-downloader-types';
import { emitDownloadProgress } from './downloadEvents';
import { listDownloadedModels } from './localModels';
import { consumePausedExtractionRequest } from './modelExtraction';
import {
  getArchivePath,
  getDownloadStatePath,
  getModelDir,
  getNativeAssetExtractedModelDir,
  getReadyMarkerPath,
  getSourceModelsBaseDir,
  getTempModelDir,
} from './paths';
import { runPostDownloadProcessing } from './postDownloadProcessing';
import { getModelById } from './registry';
import {
  assertSupportedLayout,
  assertValidLayoutAssets,
  DownloadError,
  DOWNLOAD_ERROR_CODES,
} from './sources';
import {
  type DownloadOptions,
  type DownloadResult,
  type ModelMeta,
  ModelCategory,
  PauseError,
} from './types';
import {
  checkDiskSpace,
  removeDirectoryRecursive,
  validateChecksum,
} from './validation';

const DOWNLOAD_STATE_PREFIX = '.download-state-';
const DOWNLOAD_STATE_SUFFIX = '.json';

type DownloadStateFile = {
  modelId: string;
  sourceId: string;
  category: ModelCategory;
  phase: 'downloading';
  startedAt: string;
  downloadPath: string;
  layout: ModelMeta['layout'];
  model: ModelMeta;
  nextAssetIndex?: number;
  totalBytes?: number;
};

type ActiveDownloadOperation = {
  taskId: string;
  task: DownloadTask;
  pauseRequested: boolean;
  aborted: boolean;
  rejectPause?: () => void;
};

function resolveSourceId(source?: string | 'default'): string {
  if (!source || source === 'default') {
    return 'default';
  }

  return source;
}

function makeDownloadTaskId(
  category: ModelCategory,
  id: string,
  sourceId: string
): string {
  return `${category}:${sourceId}:${id}`;
}

function parseDownloadTaskId(taskId: string): {
  category: ModelCategory;
  sourceId: string;
  modelId: string;
} | null {
  const parts = taskId.split(':');
  if (parts.length < 3) {
    return null;
  }

  const category = parts[0] as ModelCategory;
  const encodedSource = parts[1];
  const maybeIndex = parts[parts.length - 1];
  const hasAssetIndex =
    typeof maybeIndex === 'string' && maybeIndex.length > 0
      ? /^\d+$/.test(maybeIndex)
      : false;
  const modelId = hasAssetIndex
    ? parts.slice(2, -1).join(':')
    : parts.slice(2).join(':');

  if (!category || !encodedSource || !modelId) {
    return null;
  }

  return {
    category,
    sourceId: encodedSource,
    modelId,
  };
}

const activeDownloadTasks = new Map<string, DownloadTask>();
const activeDownloadOperations = new Map<string, ActiveDownloadOperation>();

let androidDownloaderNotificationConfigApplied = false;
let didWarnConfigFailure = false;

function warnBackgroundDownloaderConfigFailure(
  context: string,
  error: unknown
): void {
  if (didWarnConfigFailure) {
    return;
  }

  didWarnConfigFailure = true;
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(
    `[Download] Background downloader config failed (${context}): ${reason}`
  );
}

function createAbortError(): Error {
  const abortError = new Error('Download aborted');
  abortError.name = 'AbortError';
  return abortError;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function removeIfExists(path: string): Promise<void> {
  if (await exists(path)) {
    await unlink(path);
  }
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) {
    return path;
  }
  return path.slice(0, idx);
}

async function cleanupCanceledDownload(
  category: ModelCategory,
  id: string,
  sourceId: string,
  isArchive: boolean,
  downloadPath: string,
  modelDir: string,
  statePath: string
): Promise<void> {
  try {
    await removeIfExists(statePath);
  } catch {
    // ignore
  }

  try {
    if (isArchive && (await exists(modelDir))) {
      await unlink(modelDir);
    }
  } catch {
    // ignore
  }

  try {
    await removeIfExists(downloadPath);
  } catch {
    // ignore
  }

  try {
    await removeDirectoryRecursive(getNativeAssetExtractedModelDir(id));
  } catch {
    // ignore
  }

  try {
    const readyMarkerPath = getReadyMarkerPath(category, id, sourceId);
    await removeIfExists(readyMarkerPath);
  } catch {
    // ignore
  }
}

/**
 * Apply custom background-downloader config before first model download.
 */
export function configureBackgroundDownloader(
  options: BackgroundDownloaderSetConfigOptions
): void {
  try {
    setConfig(options);
    androidDownloaderNotificationConfigApplied = true;
  } catch (error) {
    warnBackgroundDownloaderConfigFailure('custom', error);
  }
}

/**
 * Library default is showNotificationsEnabled: false.
 * Enable visible notifications unless host app configured downloader explicitly.
 */
function ensureAndroidBackgroundDownloaderNotifications(): void {
  if (androidDownloaderNotificationConfigApplied) {
    return;
  }
  if (Platform.OS !== 'android') {
    return;
  }

  try {
    setConfig({
      showNotificationsEnabled: true,
      notificationsGrouping: {
        enabled: false,
        mode: 'individual',
        texts: {
          downloadTitle: 'Model download',
          downloadStarting: 'Starting download...',
          downloadProgress: 'Downloading... {progress}%',
        },
      },
    });
    androidDownloaderNotificationConfigApplied = true;
  } catch (error) {
    warnBackgroundDownloaderConfigFailure('default', error);
  }
}

type TrackDownloadTaskOptions = {
  category: ModelCategory;
  id: string;
  sourceId: string;
  model: ModelMeta;
  downloadPath: string;
  modelDir: string;
  isArchive: boolean;
  statePath: string;
  opts?: DownloadOptions;
  task: DownloadTask;
  startMode: 'start' | 'resume';
};

function trackDownloadTask({
  category,
  id,
  sourceId,
  model,
  downloadPath,
  modelDir,
  isArchive,
  statePath,
  opts,
  task,
  startMode,
}: TrackDownloadTaskOptions): Promise<DownloadResult> {
  const taskId = makeDownloadTaskId(category, id, sourceId);

  return new Promise<DownloadResult>((resolve, reject) => {
    let settled = false;
    let abortHandler: (() => void) | undefined;

    const operation: ActiveDownloadOperation = {
      taskId,
      task,
      pauseRequested: false,
      aborted: Boolean(opts?.signal?.aborted),
    };

    const cleanup = () => {
      if (abortHandler && opts?.signal) {
        opts.signal.removeEventListener('abort', abortHandler);
        abortHandler = undefined;
      }
      activeDownloadTasks.delete(taskId);
      activeDownloadOperations.delete(taskId);
    };

    const safeResolve = (value: DownloadResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    const safeReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    operation.rejectPause = () => {
      safeReject(new PauseError(category, id, 'Download paused'));
    };

    activeDownloadTasks.set(taskId, task);
    activeDownloadOperations.set(taskId, operation);

    task
      .progress(({ bytesDownloaded, bytesTotal }) => {
        if (
          operation.pauseRequested ||
          operation.aborted ||
          opts?.signal?.aborted
        ) {
          return;
        }

        const total = bytesTotal ?? model.bytes ?? 0;
        const percent = total > 0 ? (bytesDownloaded / total) * 100 : 0;
        const progress = {
          bytesProcessed: bytesDownloaded,
          totalBytes: total,
          percent,
          phase: 'downloading' as const,
        };

        opts?.onProgress?.(progress);
        emitDownloadProgress(category, id, progress);
      })
      .done(async () => {
        completeHandler(taskId);

        if (operation.pauseRequested) {
          safeReject(new PauseError(category, id, 'Download paused'));
          return;
        }

        if (operation.aborted || opts?.signal?.aborted) {
          await cleanupCanceledDownload(
            category,
            id,
            sourceId,
            isArchive,
            downloadPath,
            modelDir,
            statePath
          );
          safeReject(createAbortError());
          return;
        }

        try {
          const result = await runPostDownloadProcessing({
            category,
            id,
            model,
            downloadPath,
            modelDir,
            isArchive,
            statePath,
            signal: opts?.signal,
            verifyChecksum: opts?.verifyChecksum,
            onChecksumMismatch: opts?.onChecksumMismatch,
            deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
            onProgress: opts?.onProgress,
            getDownloadedList: () =>
              listDownloadedModels(category, { source: sourceId }),
            extractionOperationId: `extract:${makeModelOperationKey(
              category,
              id,
              sourceId
            )}`,
          });

          safeResolve(result);
        } catch (error) {
          if (operation.pauseRequested) {
            safeReject(new PauseError(category, id, 'Download paused'));
            return;
          }

          if (
            operation.aborted ||
            opts?.signal?.aborted ||
            isAbortError(error)
          ) {
            if (consumePausedExtractionRequest(category, id, sourceId)) {
              safeReject(new PauseError(category, id, 'Extraction paused'));
              return;
            }

            await cleanupCanceledDownload(
              category,
              id,
              sourceId,
              isArchive,
              downloadPath,
              modelDir,
              statePath
            );
            safeReject(createAbortError());
            return;
          }

          safeReject(toError(error));
        }
      })
      .error(({ error, errorCode }) => {
        completeHandler(taskId);

        if (operation.pauseRequested) {
          safeReject(new PauseError(category, id, 'Download paused'));
          return;
        }

        if (operation.aborted || opts?.signal?.aborted) {
          cleanupCanceledDownload(
            category,
            id,
            sourceId,
            isArchive,
            downloadPath,
            modelDir,
            statePath
          ).catch(() => {});
          safeReject(createAbortError());
          return;
        }

        removeIfExists(statePath).catch(() => {});
        safeReject(
          new Error(
            typeof error === 'string' ? error : String(errorCode ?? error)
          )
        );
      });

    if (opts?.signal) {
      abortHandler = () => {
        operation.aborted = true;
        task.stop();
        cleanupCanceledDownload(
          category,
          id,
          sourceId,
          isArchive,
          downloadPath,
          modelDir,
          statePath
        ).catch(() => {});
        safeReject(createAbortError());
      };
      opts.signal.addEventListener('abort', abortHandler);
    }

    if (startMode === 'start') {
      task.start();
    } else {
      task.resume().catch(() => {
        // Some implementations reject resume() if already active.
      });
    }
  });
}

async function trackAssetDownloadTask(params: {
  category: ModelCategory;
  id: string;
  sourceId: string;
  task: DownloadTask;
  signal?: AbortSignal;
  onProgress?: (bytesDownloaded: number, bytesTotal: number) => void;
}): Promise<void> {
  const key = makeDownloadTaskId(params.category, params.id, params.sourceId);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let abortHandler: (() => void) | undefined;

    const cleanup = () => {
      if (abortHandler && params.signal) {
        params.signal.removeEventListener('abort', abortHandler);
        abortHandler = undefined;
      }
      activeDownloadTasks.delete(key);
      activeDownloadOperations.delete(key);
    };

    const safeResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const safeReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const operation: ActiveDownloadOperation = {
      taskId: key,
      task: params.task,
      pauseRequested: false,
      aborted: Boolean(params.signal?.aborted),
      rejectPause: () => {
        safeReject(
          new PauseError(params.category, params.id, 'Download paused')
        );
      },
    };

    activeDownloadTasks.set(key, params.task);
    activeDownloadOperations.set(key, operation);

    params.task
      .progress(({ bytesDownloaded, bytesTotal }) => {
        if (
          operation.pauseRequested ||
          operation.aborted ||
          params.signal?.aborted
        ) {
          return;
        }
        params.onProgress?.(bytesDownloaded, bytesTotal ?? 0);
      })
      .done(() => {
        completeHandler(params.task.id ?? key);

        if (operation.pauseRequested) {
          safeReject(
            new PauseError(params.category, params.id, 'Download paused')
          );
          return;
        }

        if (operation.aborted || params.signal?.aborted) {
          safeReject(createAbortError());
          return;
        }

        safeResolve();
      })
      .error(({ error, errorCode }) => {
        completeHandler(params.task.id ?? key);
        if (operation.pauseRequested) {
          safeReject(
            new PauseError(params.category, params.id, 'Download paused')
          );
          return;
        }
        if (operation.aborted || params.signal?.aborted) {
          safeReject(createAbortError());
          return;
        }
        safeReject(
          new Error(
            typeof error === 'string' ? error : String(errorCode ?? error)
          )
        );
      });

    if (params.signal) {
      abortHandler = () => {
        operation.aborted = true;
        params.task.stop();
        safeReject(createAbortError());
      };
      params.signal.addEventListener('abort', abortHandler);
    }

    params.task.start();
  });
}

async function verifyDownloadedAssetChecksum(params: {
  category: ModelCategory;
  modelId: string;
  sourceId: string;
  relativePath: string;
  filePath: string;
  expectedSha256?: string;
  verifyChecksum?: boolean;
  onChecksumMismatch?: DownloadOptions['onChecksumMismatch'];
}): Promise<void> {
  const {
    category,
    modelId,
    sourceId,
    relativePath,
    filePath,
    expectedSha256,
    verifyChecksum,
    onChecksumMismatch,
  } = params;

  if (verifyChecksum === false || !expectedSha256) {
    return;
  }

  const expected = expectedSha256.toLowerCase();
  const result = await validateChecksum(filePath, expected);
  if (result.success) {
    return;
  }

  const issue = {
    category,
    modelId,
    filePath,
    expected,
    reason:
      result.error === 'CHECKSUM_MISMATCH'
        ? ('CHECKSUM_MISMATCH' as const)
        : ('CHECKSUM_FAILED' as const),
  };

  const keepFile = onChecksumMismatch ? await onChecksumMismatch(issue) : false;
  if (keepFile) {
    return;
  }

  throw new DownloadError(
    DOWNLOAD_ERROR_CODES.INTEGRITY_CHECKSUM_MISMATCH,
    `Checksum verification failed for ${relativePath}`,
    {
      source: sourceId,
      category,
      modelId,
      cause: result.message ?? `checksum mismatch/failure for ${relativePath}`,
    }
  );
}

async function downloadModelOnce(
  category: ModelCategory,
  id: string,
  opts?: DownloadOptions
): Promise<DownloadResult> {
  const requestedSourceId = resolveSourceId(opts?.source);
  consumePausedExtractionRequest(category, id, requestedSourceId);

  if (opts?.signal?.aborted) {
    throw createAbortError();
  }

  const model = await getModelById(category, id, {
    source: requestedSourceId,
  });
  if (!model) {
    throw new Error(`Unknown model id: ${id}`);
  }

  const sourceId = resolveSourceId(model.sourceId);

  assertSupportedLayout(model.layout);
  assertValidLayoutAssets({
    layout: model.layout,
    assetCount: model.assets.length,
  });

  const primaryAsset = model.assets[0];
  if (!primaryAsset) {
    throw new Error(`Model ${id} has no downloadable assets`);
  }

  const baseDir = getSourceModelsBaseDir(category, sourceId);
  await mkdir(baseDir);

  const downloadPath = getArchivePath(
    category,
    id,
    model.layout,
    model.assets,
    sourceId
  );
  const isArchive = model.layout.kind === 'archive';
  const modelDir = getModelDir(category, id, sourceId);
  const statePath = getDownloadStatePath(category, id, sourceId);
  const tempDir = getTempModelDir(category, id, 'active', sourceId);

  const diskSpaceCheck = await checkDiskSpace(model.bytes);
  if (!diskSpaceCheck.success) {
    throw new Error(`Insufficient disk space: ${diskSpaceCheck.message}`);
  }

  ensureAndroidBackgroundDownloaderNotifications();

  if (opts?.overwrite) {
    await removeIfExists(modelDir);
    await removeIfExists(downloadPath);
    await removeIfExists(statePath);
  } else {
    const readyMarkerExists = await exists(
      getReadyMarkerPath(category, id, sourceId)
    );
    if (!readyMarkerExists && isArchive && (await exists(modelDir))) {
      await unlink(modelDir);
    }
  }

  const isMultiAssetFolder = !isArchive && model.assets.length > 1;

  let resumeNextAssetIndex = 0;
  if (isMultiAssetFolder && !opts?.overwrite && (await exists(statePath))) {
    try {
      const raw = await readFile(statePath, 'utf8');
      const state = JSON.parse(raw) as Partial<DownloadStateFile>;
      const sameSource = resolveSourceId(state.sourceId) === sourceId;
      const sameModel = state.modelId === id;
      const nextIndex = state.nextAssetIndex;
      if (
        sameSource &&
        sameModel &&
        typeof nextIndex === 'number' &&
        nextIndex >= 0 &&
        nextIndex < model.assets.length
      ) {
        resumeNextAssetIndex = nextIndex;
      }
    } catch {
      resumeNextAssetIndex = 0;
    }
  }

  const downloadState: DownloadStateFile = {
    modelId: id,
    sourceId,
    category,
    phase: 'downloading',
    startedAt: new Date().toISOString(),
    downloadPath,
    layout: model.layout,
    model,
    nextAssetIndex: isMultiAssetFolder ? resumeNextAssetIndex : undefined,
    totalBytes: model.bytes,
  };

  await writeFile(statePath, JSON.stringify(downloadState), 'utf8');

  if (isMultiAssetFolder) {
    if (opts?.overwrite) {
      await removeDirectoryRecursive(tempDir);
    }
    await mkdir(tempDir);

    let completedBytes = 0;
    const totalBytes = model.bytes;

    for (let index = 0; index < resumeNextAssetIndex; index += 1) {
      const priorAsset = model.assets[index];
      if (!priorAsset) {
        continue;
      }

      const relativePath = normalizeRelativePath(priorAsset.relativePath);
      const destination = `${tempDir}/${relativePath}`;
      try {
        const fileStat = await stat(destination);
        completedBytes += fileStat.size ?? priorAsset.bytes ?? 0;
      } catch {
        completedBytes += priorAsset.bytes ?? 0;
      }
    }

    try {
      for (
        let index = resumeNextAssetIndex;
        index < model.assets.length;
        index += 1
      ) {
        const asset = model.assets[index];
        if (!asset) {
          continue;
        }

        const relativePath = normalizeRelativePath(asset.relativePath);
        const destination = `${tempDir}/${relativePath}`;
        await mkdir(dirname(destination));

        await writeFile(
          statePath,
          JSON.stringify({
            ...downloadState,
            downloadPath: destination,
            nextAssetIndex: index,
          }),
          'utf8'
        );

        const task = createDownloadTask({
          id: `${makeDownloadTaskId(category, id, sourceId)}:${index}`,
          url: asset.url,
          destination,
          metadata: {},
        });

        await trackAssetDownloadTask({
          category,
          id,
          sourceId,
          task,
          signal: opts?.signal,
          onProgress: (bytesDownloaded, bytesTotal) => {
            const currentTotal =
              totalBytes > 0
                ? totalBytes
                : completedBytes +
                  (bytesTotal > 0 ? bytesTotal : bytesDownloaded);
            const processed = completedBytes + bytesDownloaded;
            const percent =
              currentTotal > 0 ? (processed / currentTotal) * 100 : 0;
            const progress = {
              bytesProcessed: processed,
              totalBytes: currentTotal,
              percent,
              phase: 'downloading' as const,
            };

            opts?.onProgress?.(progress);
            emitDownloadProgress(category, id, progress);
          },
        });

        await verifyDownloadedAssetChecksum({
          category,
          modelId: id,
          sourceId,
          relativePath,
          filePath: destination,
          expectedSha256: asset.sha256,
          verifyChecksum: opts?.verifyChecksum,
          onChecksumMismatch: opts?.onChecksumMismatch,
        });

        try {
          const fileStat = await stat(destination);
          completedBytes += fileStat.size ?? asset.bytes ?? 0;
        } catch {
          completedBytes += asset.bytes ?? 0;
        }

        await writeFile(
          statePath,
          JSON.stringify({
            ...downloadState,
            downloadPath: destination,
            nextAssetIndex: index + 1,
          }),
          'utf8'
        );
      }

      if (await exists(modelDir)) {
        await unlink(modelDir);
      }

      await moveFile(tempDir, modelDir);

      const firstRelativePath = normalizeRelativePath(
        primaryAsset.relativePath
      );
      const finalPrimaryPath = `${modelDir}/${firstRelativePath}`;

      return runPostDownloadProcessing({
        category,
        id,
        model,
        downloadPath: finalPrimaryPath,
        modelDir,
        isArchive: false,
        statePath,
        signal: opts?.signal,
        verifyChecksum: false,
        onChecksumMismatch: opts?.onChecksumMismatch,
        deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
        onProgress: opts?.onProgress,
        getDownloadedList: () =>
          listDownloadedModels(category, { source: sourceId }),
        extractionOperationId: `extract:${makeModelOperationKey(
          category,
          id,
          sourceId
        )}`,
      });
    } catch (error) {
      if (error instanceof PauseError) {
        throw error;
      }

      await removeDirectoryRecursive(tempDir);
      await removeDirectoryRecursive(modelDir);
      await removeIfExists(statePath);
      throw error;
    }
  }

  if (!isArchive) {
    await mkdir(modelDir);
  }

  const task = createDownloadTask({
    id: makeDownloadTaskId(category, id, sourceId),
    url: primaryAsset.url,
    destination: downloadPath,
    metadata: {},
  });

  return trackDownloadTask({
    category,
    id,
    sourceId,
    model,
    downloadPath,
    modelDir,
    isArchive,
    statePath,
    opts,
    task,
    startMode: 'start',
  });
}

export async function downloadModel(
  category: ModelCategory,
  id: string,
  opts?: DownloadOptions
): Promise<DownloadResult> {
  return downloadModelOnce(category, id, opts);
}

async function listDownloadStateModelIds(
  category: ModelCategory,
  sourceId: string
): Promise<string[]> {
  const baseDir = getSourceModelsBaseDir(category, sourceId);
  if (!(await exists(baseDir))) {
    return [];
  }

  const entries = await readDir(baseDir);
  const ids: string[] = [];

  for (const entry of entries) {
    const name = entry.name;
    if (
      !name.startsWith(DOWNLOAD_STATE_PREFIX) ||
      !name.endsWith(DOWNLOAD_STATE_SUFFIX)
    ) {
      continue;
    }

    ids.push(
      name.slice(
        DOWNLOAD_STATE_PREFIX.length,
        name.length - DOWNLOAD_STATE_SUFFIX.length
      )
    );
  }

  return ids;
}

export async function getIncompleteDownloads(
  category: ModelCategory,
  options?: { source?: string | 'default' }
): Promise<
  Array<{
    modelId: string;
    category: ModelCategory;
    phase: 'downloading';
    startedAt: string;
    downloadPath: string;
    model: ModelMeta;
    bytesDownloaded?: number;
    totalBytes?: number;
  }>
> {
  const statesByModelId = new Map<
    string,
    {
      modelId: string;
      category: ModelCategory;
      phase: 'downloading';
      startedAt: string;
      downloadPath: string;
      model: ModelMeta;
      bytesDownloaded?: number;
      totalBytes?: number;
    }
  >();

  const sourceId = resolveSourceId(options?.source);

  const stateModelIds = await listDownloadStateModelIds(category, sourceId);

  for (const modelId of stateModelIds) {
    const statePath = getDownloadStatePath(category, modelId, sourceId);
    try {
      const raw = await readFile(statePath, 'utf8');
      const state = JSON.parse(raw) as DownloadStateFile;
      const effectiveSourceId = resolveSourceId(
        state.sourceId ?? state.model?.sourceId
      );
      const readyPath = getReadyMarkerPath(
        category,
        modelId,
        effectiveSourceId
      );
      if (await exists(readyPath)) {
        continue;
      }

      if (!state.model) {
        continue;
      }

      statesByModelId.set(modelId, {
        modelId,
        category,
        phase: 'downloading',
        startedAt: state.startedAt ?? new Date().toISOString(),
        downloadPath:
          state.downloadPath ??
          (state as DownloadStateFile & { archivePath?: string }).archivePath ??
          getArchivePath(
            category,
            modelId,
            state.model.layout,
            state.model.assets,
            effectiveSourceId
          ),
        model: state.model,
        totalBytes: state.totalBytes ?? state.model.bytes,
      });
    } catch {
      // ignore invalid state file
    }
  }

  const existingTasks = await getExistingDownloadTasks();
  for (const task of existingTasks) {
    if (!task.id) {
      continue;
    }

    const parsed = parseDownloadTaskId(task.id);
    if (
      !parsed ||
      parsed.category !== category ||
      parsed.sourceId !== sourceId
    ) {
      continue;
    }

    const modelId = parsed.modelId;
    if (statesByModelId.has(modelId)) {
      continue;
    }

    const readyPath = getReadyMarkerPath(category, modelId, sourceId);
    if (await exists(readyPath)) {
      continue;
    }

    const model = await getModelById(category, modelId, {
      source: sourceId,
    });
    if (!model) {
      continue;
    }

    statesByModelId.set(modelId, {
      modelId,
      category,
      phase: 'downloading',
      startedAt: new Date().toISOString(),
      downloadPath: getArchivePath(
        category,
        modelId,
        model.layout,
        model.assets,
        sourceId
      ),
      model,
      totalBytes: model.bytes,
    });
  }

  for (const state of statesByModelId.values()) {
    try {
      const fileStat = await stat(state.downloadPath);
      if (fileStat.size != null && fileStat.size >= 0) {
        state.bytesDownloaded = fileStat.size;
      }
    } catch {
      // ignore missing file
    }
  }

  return [...statesByModelId.values()];
}

export async function resumeDownload(
  category: ModelCategory,
  id: string,
  opts?: DownloadOptions
): Promise<DownloadResult> {
  const sourceId = resolveSourceId(opts?.source);
  consumePausedExtractionRequest(category, id, sourceId);

  if (opts?.signal?.aborted) {
    throw createAbortError();
  }

  ensureAndroidBackgroundDownloaderNotifications();

  const taskId = makeDownloadTaskId(category, id, sourceId);
  const existingTasks = await getExistingDownloadTasks();
  const existing = existingTasks.find(
    (task) => task.id === taskId || task.id?.startsWith(`${taskId}:`)
  );

  if (!existing) {
    return downloadModel(category, id, {
      ...opts,
      overwrite: false,
    });
  }

  const model = await getModelById(category, id, {
    source: sourceId,
  });
  if (!model) {
    throw new Error(`Unknown model id: ${id}`);
  }

  if (model.layout.kind === 'folder' && model.assets.length > 1) {
    return downloadModel(category, id, {
      ...opts,
      source: sourceId,
      overwrite: false,
    });
  }

  const downloadPath = getArchivePath(
    category,
    id,
    model.layout,
    model.assets,
    sourceId
  );
  const modelDir = getModelDir(category, id, sourceId);
  const isArchive = model.layout.kind === 'archive';
  const statePath = getDownloadStatePath(category, id, sourceId);

  if (!(await exists(statePath))) {
    const state: DownloadStateFile = {
      modelId: id,
      sourceId,
      category,
      phase: 'downloading',
      startedAt: new Date().toISOString(),
      downloadPath,
      layout: model.layout,
      model,
      totalBytes: model.bytes,
    };
    await writeFile(statePath, JSON.stringify(state), 'utf8');
  }

  return trackDownloadTask({
    category,
    id,
    sourceId,
    model,
    downloadPath,
    modelDir,
    isArchive,
    statePath,
    opts,
    task: existing,
    startMode: 'resume',
  });
}

export async function pauseDownload(
  category: ModelCategory,
  id: string,
  source = 'default'
): Promise<void> {
  const sourceId = resolveSourceId(source);
  const taskId = makeModelOperationKey(category, id, sourceId);

  const activeOperation = activeDownloadOperations.get(taskId);
  if (activeOperation) {
    activeOperation.pauseRequested = true;
    try {
      await activeOperation.task.pause();
    } catch {
      try {
        activeOperation.task.stop();
      } catch {
        // ignore
      }
    }
    activeOperation.rejectPause?.();
    return;
  }

  const existingTasks = await getExistingDownloadTasks();
  const task = existingTasks.find(
    (entry) => entry.id === taskId || entry.id?.startsWith(`${taskId}:`)
  );

  if (!task) {
    return;
  }

  try {
    await task.pause();
  } catch {
    try {
      task.stop();
    } catch {
      // ignore
    }
  }
}

export async function deleteIncompleteDownload(
  category: ModelCategory,
  id: string,
  source = 'default'
): Promise<void> {
  const sourceId = resolveSourceId(source);
  const taskId = makeDownloadTaskId(category, id, sourceId);
  const existingTasks = await getExistingDownloadTasks();
  const tasks = existingTasks.filter(
    (entry) => entry.id === taskId || entry.id?.startsWith(`${taskId}:`)
  );

  for (const task of tasks) {
    task.stop();
  }

  activeDownloadTasks.delete(taskId);
  activeDownloadOperations.delete(taskId);

  const modelDir = getModelDir(category, id, sourceId);
  const statePath = getDownloadStatePath(category, id, sourceId);
  let downloadPath: string | null = null;

  try {
    if (await exists(statePath)) {
      const raw = await readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw) as DownloadStateFile;
      downloadPath = parsed.downloadPath;
    }
  } catch {
    // ignore
  }

  if (await exists(modelDir)) {
    await unlink(modelDir);
  }
  if (downloadPath && (await exists(downloadPath))) {
    await unlink(downloadPath);
  }
  if (await exists(statePath)) {
    await unlink(statePath);
  }

  const baseDir = getSourceModelsBaseDir(category, sourceId);
  if (await exists(baseDir)) {
    const entries = await readDir(baseDir);
    for (const entry of entries) {
      if (entry.name.startsWith(`.tmp-${id}-`) && entry.isDirectory()) {
        await removeDirectoryRecursive(`${baseDir}/${entry.name}`);
      }
    }
  }

  await removeDirectoryRecursive(getNativeAssetExtractedModelDir(id));
}

/** Task ids in the form `category:sourceId:modelId` for downloads currently tracked in JS. */
export function getActiveDownloadTaskKeys(): string[] {
  return [...activeDownloadTasks.keys()];
}
