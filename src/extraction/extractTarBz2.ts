import { DeviceEventEmitter } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import type { ExtractNotificationArgs } from './types';

export type ExtractProgressEvent = {
  bytes: number;
  totalBytes: number;
  percent: number;
};

type ExtractResult = {
  success: boolean;
  path?: string;
  sha256?: string;
  reason?: string;
};

export async function extractTarBz2(
  sourcePath: string,
  targetPath: string,
  force = true,
  onProgress?: (event: ExtractProgressEvent) => void,
  signal?: AbortSignal,
  notification?: ExtractNotificationArgs
): Promise<ExtractResult> {
  let subscription: { remove: () => void } | null = null;
  let removeAbortListener: (() => void) | null = null;

  if (signal?.aborted) {
    const abortError = new Error('Extraction aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }

  if (onProgress) {
    subscription = DeviceEventEmitter.addListener(
      'extractTarBz2Progress',
      (event: ExtractProgressEvent & { sourcePath?: string }) => {
        // Only handle events for this extraction (fixes parallel extractions showing same %)
        if (event.sourcePath != null && event.sourcePath !== sourcePath) {
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
        // Use per-path cancel so aborting this extraction doesn't affect
        // other extractions that may be running in parallel.
        SherpaOnnx.cancelExtractBySourcePath(sourcePath);
      } catch {
        // Ignore cancel errors to avoid crashing on abort.
      }
    };
    signal.addEventListener('abort', onAbort);
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  }

  try {
    const result = await SherpaOnnx.extractTarBz2(
      sourcePath,
      targetPath,
      force,
      notification?.showNotificationsEnabled,
      notification?.notificationTitle,
      notification?.notificationText
    );
    if (!result.success) {
      const message = result.reason || 'Extraction failed';
      const error = new Error(message);
      if (signal?.aborted || /cancel/i.test(message)) {
        error.name = 'AbortError';
      }
      throw error;
    }
    return result;
  } finally {
    subscription?.remove();
    removeAbortListener?.();
  }
}
