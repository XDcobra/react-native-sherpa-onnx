/**
 * Download tasks shared by the model download flows: the registry of running tasks
 * (for pause and delete), one tracked file download, and its checksum check.
 */
import {
  cancelForegroundDownload,
  type ForegroundDownloadTask,
} from './foregroundDownload';
import { DownloadError, DOWNLOAD_ERROR_CODES } from './sources/errors';
import { buildSourceFetchContext, getSource } from './sources/registry';
import { type DownloadOptions, type ModelCategory, PauseError } from './types';
import { validateChecksum } from './validation';

export type ActiveDownloadOperation = {
  taskId: string;
  task: ForegroundDownloadTask;
  pauseRequested: boolean;
  aborted: boolean;
  rejectPause?: () => void;
};

export function makeDownloadTaskId(
  category: ModelCategory,
  id: string,
  sourceId: string
): string {
  return `${category}:${sourceId}:${id}`;
}

export const activeDownloadTasks = new Map<string, ForegroundDownloadTask>();
export const activeDownloadOperations = new Map<
  string,
  ActiveDownloadOperation
>();

export function resolveDownloadHeaders(
  sourceId: string
): Record<string, string> {
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

export function createAbortError(): Error {
  const abortError = new Error('Download aborted');
  abortError.name = 'AbortError';
  return abortError;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function trackAssetDownloadTask(params: {
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

export async function verifyDownloadedAssetChecksum(params: {
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
