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
import { makeModelOperationKey } from './activeModelOperations';
import { runAssetIndicesWithConcurrency } from './downloadConcurrency';
import {
  cancelForegroundDownload,
  createForegroundDownloadTask,
  type ForegroundDownloadTask,
} from './foregroundDownload';
import { emitDownloadProgress, emitModelsListUpdated } from './downloadEvents';
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
import { buildSourceFetchContext, getSource } from './sources/registry';
import { DownloadError, DOWNLOAD_ERROR_CODES } from './sources/errors';
import {
  assertSupportedLayout,
  assertValidLayoutAssets,
} from './sources/formats';
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
  failedAssetIndices?: number[];
};

type ActiveDownloadOperation = {
  taskId: string;
  task: ForegroundDownloadTask;
  pauseRequested: boolean;
  aborted: boolean;
  rejectPause?: () => void;
};

export type DownloadManagerConfig = {
  maxParallelDownloads?: number;
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

const activeDownloadTasks = new Map<string, ForegroundDownloadTask>();
const activeDownloadOperations = new Map<string, ActiveDownloadOperation>();

let multiAssetParallelLimit = 3;

function resolveDownloadHeaders(sourceId: string): Record<string, string> {
  try {
    const provider = getSource(sourceId);
    const ctx = buildSourceFetchContext(sourceId, provider);
    const headers: Record<string, string> = { ...ctx.headers };
    if (ctx.token) {
      headers.Authorization = `${ctx.tokenScheme ?? 'Bearer'} ${ctx.token}`;
    }
    return headers;
  } catch {
    return {};
  }
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

/** Configure foreground download manager (parallel multi-asset limit). */
export function configureDownloadManager(
  options?: DownloadManagerConfig
): void {
  if (
    typeof options?.maxParallelDownloads === 'number' &&
    options.maxParallelDownloads >= 1
  ) {
    multiAssetParallelLimit = options.maxParallelDownloads;
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
  task: ForegroundDownloadTask;
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
            showExtractionNotifications: opts?.showExtractionNotifications,
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
        cancelForegroundDownload(taskId).catch(() => {});
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
  task: ForegroundDownloadTask;
  signal?: AbortSignal;
  onProgress?: (bytesDownloaded: number, bytesTotal: number) => void;
}): Promise<void> {
  const key =
    params.task.id ??
    makeDownloadTaskId(params.category, params.id, params.sourceId);

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
        cancelForegroundDownload(params.task.id ?? key).catch(() => {});
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
  let resumeFailedAssetIndices: number[] = [];
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
        nextIndex <= model.assets.length
      ) {
        resumeNextAssetIndex = nextIndex;
      }
      const failed = state.failedAssetIndices;
      if (Array.isArray(failed)) {
        resumeFailedAssetIndices = failed
          .filter(
            (idx): idx is number =>
              typeof idx === 'number' && idx >= 0 && idx < model.assets.length
          )
          .sort((a, b) => a - b);
      }
    } catch {
      resumeNextAssetIndex = 0;
      resumeFailedAssetIndices = [];
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

  const downloadHeaders = resolveDownloadHeaders(sourceId);

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
      const failedIndices = new Set<number>(resumeFailedAssetIndices);
      const retryFailedOnly =
        resumeNextAssetIndex >= model.assets.length && failedIndices.size > 0;
      const pendingIndices = retryFailedOnly
        ? [...failedIndices].sort((a, b) => a - b)
        : Array.from(
            new Set<number>([
              ...Array.from(
                {
                  length: Math.max(
                    0,
                    model.assets.length - resumeNextAssetIndex
                  ),
                },
                (_unused, offset) => resumeNextAssetIndex + offset
              ),
              ...failedIndices,
            ])
          ).sort((a, b) => a - b);

      const inFlightProgress = new Map<number, number>();
      let stateWriteChain: Promise<void> = Promise.resolve();
      let completedAssetCount = resumeNextAssetIndex;

      const persistDownloadState = (payload: Record<string, unknown>) => {
        stateWriteChain = stateWriteChain.then(() =>
          writeFile(statePath, JSON.stringify(payload), 'utf8').then(() => {})
        );
        return stateWriteChain;
      };

      const reportAggregateProgress = (activeIndex: number) => {
        let inFlightBytes = 0;
        for (const bytes of inFlightProgress.values()) {
          inFlightBytes += bytes;
        }
        const currentTotal =
          totalBytes > 0 ? totalBytes : completedBytes + inFlightBytes;
        const processed = completedBytes + inFlightBytes;
        const percent = currentTotal > 0 ? (processed / currentTotal) * 100 : 0;
        const progress = {
          bytesProcessed: processed,
          totalBytes: currentTotal,
          percent,
          phase: 'downloading' as const,
          assetIndex: activeIndex,
          assetCount: model.assets.length,
        };
        opts?.onProgress?.(progress);
        emitDownloadProgress(category, id, progress);
      };

      await runAssetIndicesWithConcurrency(
        pendingIndices,
        multiAssetParallelLimit,
        async (index) => {
          const asset = model.assets[index];
          if (!asset) {
            return;
          }

          const relativePath = normalizeRelativePath(asset.relativePath);
          const destination = `${tempDir}/${relativePath}`;
          await mkdir(dirname(destination));

          await persistDownloadState({
            ...downloadState,
            downloadPath: destination,
            nextAssetIndex: index,
          });

          const task = createForegroundDownloadTask({
            id: `${makeDownloadTaskId(category, id, sourceId)}:${index}`,
            url: asset.url,
            destination,
            headers: downloadHeaders,
          });

          try {
            await trackAssetDownloadTask({
              category,
              id,
              sourceId,
              task,
              signal: opts?.signal,
              onProgress: (bytesDownloaded) => {
                inFlightProgress.set(index, bytesDownloaded);
                reportAggregateProgress(index);
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

            inFlightProgress.delete(index);
            failedIndices.delete(index);
            try {
              const fileStat = await stat(destination);
              completedBytes += fileStat.size ?? asset.bytes ?? 0;
            } catch {
              completedBytes += asset.bytes ?? 0;
            }
            completedAssetCount += 1;
          } catch (error) {
            inFlightProgress.delete(index);
            if (error instanceof PauseError || isAbortError(error)) {
              throw error;
            }
            failedIndices.add(index);
            completedBytes += asset.bytes ?? 0;
          }

          await persistDownloadState({
            ...downloadState,
            downloadPath: destination,
            nextAssetIndex: Math.max(index + 1, completedAssetCount),
            failedAssetIndices: [...failedIndices].sort((a, b) => a - b),
          });
        }
      );

      await stateWriteChain;

      if (failedIndices.size > 0) {
        await writeFile(
          statePath,
          JSON.stringify({
            ...downloadState,
            nextAssetIndex: model.assets.length,
            failedAssetIndices: [...failedIndices].sort((a, b) => a - b),
          }),
          'utf8'
        );
        throw new Error(
          `Download incomplete: ${failedIndices.size} file(s) failed. Tap retry to download only failed files.`
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
        showExtractionNotifications: opts?.showExtractionNotifications,
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

      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('Download incomplete:')) {
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

  const task = createForegroundDownloadTask({
    id: makeDownloadTaskId(category, id, sourceId),
    url: primaryAsset.url,
    destination: downloadPath,
    headers: downloadHeaders,
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

  return downloadModel(category, id, {
    ...opts,
    source: sourceId,
    overwrite: false,
  });
}

export async function pauseDownload(
  category: ModelCategory,
  id: string,
  source = 'default'
): Promise<void> {
  const sourceId = resolveSourceId(source);
  const baseTaskId = makeDownloadTaskId(category, id, sourceId);

  const matching: ActiveDownloadOperation[] = [];
  for (const [key, operation] of activeDownloadOperations) {
    if (key === baseTaskId || key.startsWith(`${baseTaskId}:`)) {
      matching.push(operation);
    }
  }

  if (matching.length === 0) {
    return;
  }

  await Promise.all(
    matching.map(async (activeOperation) => {
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
    })
  );
}

export async function deleteIncompleteDownload(
  category: ModelCategory,
  id: string,
  source = 'default'
): Promise<void> {
  const sourceId = resolveSourceId(source);
  const taskId = makeDownloadTaskId(category, id, sourceId);

  await cancelForegroundDownload(taskId);
  const model = await getModelById(category, id, { source: sourceId });
  if (model && model.assets.length > 1) {
    for (let index = 0; index < model.assets.length; index += 1) {
      await cancelForegroundDownload(`${taskId}:${index}`);
    }
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

  try {
    const list = await listDownloadedModels(category, { source: sourceId });
    emitModelsListUpdated(category, list);
  } catch {
    emitModelsListUpdated(category, []);
  }
}

/** Task ids in the form `category:sourceId:modelId` for downloads currently tracked in JS. */
export function getActiveDownloadTaskKeys(): string[] {
  return [...activeDownloadTasks.keys()];
}
