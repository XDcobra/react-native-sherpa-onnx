import {
  completeHandler,
  createDownloadTask,
  getExistingDownloadTasks,
  setConfig,
} from '@kesha-antonov/react-native-background-downloader';
import {
  exists,
  mkdir,
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
  getModelsBaseDir,
  getNativeAssetExtractedModelDir,
  getOnnxPath,
  getReadyMarkerPath,
  getTarArchivePath,
} from './paths';
import { runPostDownloadProcessing } from './postDownloadProcessing';
import { getModelById } from './registry';
import {
  type DownloadOptions,
  type DownloadResult,
  type ModelMeta,
  ModelCategory,
  PauseError,
} from './types';
import { checkDiskSpace, removeDirectoryRecursive } from './validation';

const DOWNLOAD_STATE_PREFIX = '.download-state-';
const DOWNLOAD_STATE_SUFFIX = '.json';

type DownloadStateFile = {
  modelId: string;
  category: ModelCategory;
  phase: 'downloading';
  startedAt: string;
  archivePath: string;
  model: ModelMeta;
  totalBytes?: number;
};

type ActiveDownloadOperation = {
  taskId: string;
  task: DownloadTask;
  pauseRequested: boolean;
  aborted: boolean;
  rejectPause?: () => void;
};

function makeDownloadTaskId(category: ModelCategory, id: string): string {
  return `${category}:${id}`;
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

async function cleanupCanceledDownload(
  category: ModelCategory,
  id: string,
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
    const readyMarkerPath = getReadyMarkerPath(category, id);
    await removeIfExists(readyMarkerPath);
  } catch {
    // ignore
  }
}

async function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    if (!signal) {
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };

    signal.addEventListener('abort', onAbort);
  });
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
  model,
  downloadPath,
  modelDir,
  isArchive,
  statePath,
  opts,
  task,
  startMode,
}: TrackDownloadTaskOptions): Promise<DownloadResult> {
  const taskId = makeDownloadTaskId(category, id);

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
            getDownloadedList: () => listDownloadedModels(category),
            extractionOperationId: `extract:${category}:${id}`,
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
            if (consumePausedExtractionRequest(category, id)) {
              safeReject(new PauseError(category, id, 'Extraction paused'));
              return;
            }

            await cleanupCanceledDownload(
              category,
              id,
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

async function downloadModelOnce(
  category: ModelCategory,
  id: string,
  opts?: DownloadOptions
): Promise<DownloadResult> {
  consumePausedExtractionRequest(category, id);

  if (opts?.signal?.aborted) {
    throw createAbortError();
  }

  const model = await getModelById(category, id);
  if (!model) {
    throw new Error(`Unknown model id: ${id}`);
  }

  const baseDir = getModelsBaseDir(category);
  await mkdir(baseDir);

  const downloadPath = getArchivePath(category, id, model.archiveExt);
  const isArchive = model.archiveExt === 'tar.bz2';
  const modelDir = getModelDir(category, id);
  const statePath = getDownloadStatePath(category, id);

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
    const readyMarkerExists = await exists(getReadyMarkerPath(category, id));
    if (!readyMarkerExists && isArchive && (await exists(modelDir))) {
      await unlink(modelDir);
    }
  }

  const downloadState: DownloadStateFile = {
    modelId: id,
    category,
    phase: 'downloading',
    startedAt: new Date().toISOString(),
    archivePath: downloadPath,
    model,
    totalBytes: model.bytes,
  };

  await writeFile(statePath, JSON.stringify(downloadState), 'utf8');

  if (!isArchive) {
    await mkdir(modelDir);
  }

  const task = createDownloadTask({
    id: makeDownloadTaskId(category, id),
    url: model.downloadUrl,
    destination: downloadPath,
    metadata: {},
  });

  return trackDownloadTask({
    category,
    id,
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
  const maxRetries = Math.max(0, opts?.maxRetries ?? 2);
  let attempt = 0;

  while (true) {
    try {
      return await downloadModelOnce(category, id, opts);
    } catch (error) {
      if (
        error instanceof PauseError ||
        isAbortError(error) ||
        attempt >= maxRetries
      ) {
        throw error;
      }

      attempt += 1;
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      await waitWithAbort(delayMs, opts?.signal);
    }
  }
}

async function listDownloadStateModelIds(
  category: ModelCategory
): Promise<string[]> {
  const baseDir = getModelsBaseDir(category);
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

export async function getIncompleteDownloads(category: ModelCategory): Promise<
  Array<{
    modelId: string;
    category: ModelCategory;
    phase: 'downloading';
    startedAt: string;
    archivePath: string;
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
      archivePath: string;
      model: ModelMeta;
      bytesDownloaded?: number;
      totalBytes?: number;
    }
  >();

  const stateModelIds = await listDownloadStateModelIds(category);

  for (const modelId of stateModelIds) {
    const statePath = getDownloadStatePath(category, modelId);
    try {
      const raw = await readFile(statePath, 'utf8');
      const state = JSON.parse(raw) as DownloadStateFile;
      const readyPath = getReadyMarkerPath(category, modelId);
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
        archivePath: state.archivePath,
        model: state.model,
        totalBytes: state.totalBytes ?? state.model.bytes,
      });
    } catch {
      // ignore invalid state file
    }
  }

  const existingTasks = await getExistingDownloadTasks();
  const prefix = `${category}:`;

  for (const task of existingTasks) {
    if (!task.id || !task.id.startsWith(prefix)) {
      continue;
    }

    const modelId = task.id.slice(prefix.length);
    if (statesByModelId.has(modelId)) {
      continue;
    }

    const readyPath = getReadyMarkerPath(category, modelId);
    if (await exists(readyPath)) {
      continue;
    }

    const model = await getModelById(category, modelId);
    if (!model) {
      continue;
    }

    statesByModelId.set(modelId, {
      modelId,
      category,
      phase: 'downloading',
      startedAt: new Date().toISOString(),
      archivePath: getArchivePath(category, modelId, model.archiveExt),
      model,
      totalBytes: model.bytes,
    });
  }

  for (const state of statesByModelId.values()) {
    try {
      const fileStat = await stat(state.archivePath);
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
  consumePausedExtractionRequest(category, id);

  if (opts?.signal?.aborted) {
    throw createAbortError();
  }

  ensureAndroidBackgroundDownloaderNotifications();

  const taskId = makeDownloadTaskId(category, id);
  const existingTasks = await getExistingDownloadTasks();
  const existing = existingTasks.find((task) => task.id === taskId);

  if (!existing) {
    return downloadModel(category, id, {
      ...opts,
      overwrite: false,
    });
  }

  const model = await getModelById(category, id);
  if (!model) {
    throw new Error(`Unknown model id: ${id}`);
  }

  const downloadPath = getArchivePath(category, id, model.archiveExt);
  const modelDir = getModelDir(category, id);
  const isArchive = model.archiveExt === 'tar.bz2';
  const statePath = getDownloadStatePath(category, id);

  if (!(await exists(statePath))) {
    const state: DownloadStateFile = {
      modelId: id,
      category,
      phase: 'downloading',
      startedAt: new Date().toISOString(),
      archivePath: downloadPath,
      model,
      totalBytes: model.bytes,
    };
    await writeFile(statePath, JSON.stringify(state), 'utf8');
  }

  return trackDownloadTask({
    category,
    id,
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
  id: string
): Promise<void> {
  const taskId = makeModelOperationKey(category, id);

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
  const task = existingTasks.find((entry) => entry.id === taskId);

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
  id: string
): Promise<void> {
  const taskId = makeDownloadTaskId(category, id);
  const existingTasks = await getExistingDownloadTasks();
  const task = existingTasks.find((entry) => entry.id === taskId);

  if (task) {
    task.stop();
  }

  activeDownloadTasks.delete(taskId);
  activeDownloadOperations.delete(taskId);

  const modelDir = getModelDir(category, id);
  const tarPath = getTarArchivePath(category, id);
  const onnxPath = getOnnxPath(category, id);
  const statePath = getDownloadStatePath(category, id);

  if (await exists(modelDir)) {
    await unlink(modelDir);
  }
  if (await exists(tarPath)) {
    await unlink(tarPath);
  }
  if (await exists(onnxPath)) {
    await unlink(onnxPath);
  }
  if (await exists(statePath)) {
    await unlink(statePath);
  }

  await removeDirectoryRecursive(getNativeAssetExtractedModelDir(id));
}

/** Task ids in the form `category:modelId` for downloads currently tracked in JS. */
export function getActiveDownloadTaskKeys(): string[] {
  return [...activeDownloadTasks.keys()];
}
