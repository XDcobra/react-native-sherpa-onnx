import { DeviceEventEmitter } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';

export type ExtractProgressEvent = {
  bytes: number;
  totalBytes: number;
  percent: number;
};

type ExtractResult = {
  success: boolean;
  path?: string;
  reason?: string;
};

export async function extractTarBz2(
  sourcePath: string,
  targetPath: string,
  force = true,
  onProgress?: (event: ExtractProgressEvent) => void,
  signal?: AbortSignal
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
      onProgress
    );
  }

  if (signal) {
    const onAbort = () => {
      try {
        SherpaOnnx.cancelExtractTarBz2();
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
      force
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
