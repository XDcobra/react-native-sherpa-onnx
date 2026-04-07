import { DeviceEventEmitter } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import type { ExtractNotificationArgs, ExtractResult } from './types';

export type ExtractProgressEvent = {
  bytes: number;
  totalBytes: number;
  percent: number;
  entryIndex?: number;
  operationId?: string;
};

export type NativeExtractPathExtra = {
  skipEntries?: number;
  operationId?: string;
};

/**
 * Path-based archive extraction (.tar.bz2 / .tar.zst / … — format auto-detected natively).
 *
 * On user pause (`pauseExtraction` / cancel), returns `{ success: false, paused: true, ... }`
 * with `lastEntryIndex` for resume. Other failures throw.
 */
export async function extractTarBz2(
  sourcePath: string,
  targetPath: string,
  force = true,
  onProgress?: (event: ExtractProgressEvent) => void,
  signal?: AbortSignal,
  notification?: ExtractNotificationArgs,
  extra?: NativeExtractPathExtra
): Promise<ExtractResult> {
  const skipEntries = extra?.skipEntries ?? 0;
  const operationId = extra?.operationId ?? sourcePath;

  let subscription: { remove: () => void } | null = null;
  let removeAbortListener: (() => void) | null = null;

  if (signal?.aborted) {
    const abortError = new Error('Extraction aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }

  if (onProgress) {
    subscription = DeviceEventEmitter.addListener(
      'extractArchiveProgress',
      (event: ExtractProgressEvent & { sourcePath?: string }) => {
        if (event.sourcePath != null && event.sourcePath !== sourcePath) {
          return;
        }
        if (
          event.operationId != null &&
          event.operationId !== '' &&
          event.operationId !== operationId
        ) {
          return;
        }
        const safePercent = Math.max(0, Math.min(100, event.percent));
        onProgress({ ...event, percent: safePercent });
      }
    );
  }

  if (signal) {
    const onAbort = () => {
      try {
        SherpaOnnx.cancelExtraction(operationId);
      } catch {
        // Ignore cancel errors to avoid crashing on abort.
      }
    };
    signal.addEventListener('abort', onAbort);
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  }

  try {
    const result = await SherpaOnnx.extractArchive(
      sourcePath,
      targetPath,
      force,
      skipEntries,
      operationId,
      notification?.showNotificationsEnabled,
      notification?.notificationTitle,
      notification?.notificationText
    );

    if (!result.success && result.paused) {
      if (signal?.aborted) {
        const err = new Error(result.reason || 'Extraction aborted');
        err.name = 'AbortError';
        throw err;
      }
      return {
        success: false,
        paused: true,
        lastEntryIndex: result.lastEntryIndex,
        lastEntryPath: result.lastEntryPath ?? '',
        bytesExtracted: result.bytesExtracted,
        reason: result.reason,
      };
    }

    if (!result.success) {
      const message = result.reason || 'Extraction failed';
      const error = new Error(message);
      if (signal?.aborted || /cancel/i.test(message)) {
        error.name = 'AbortError';
      }
      throw error;
    }

    return {
      success: true,
      path: result.path,
      sha256: result.sha256,
    };
  } finally {
    subscription?.remove();
    removeAbortListener?.();
  }
}
