import { NativeEventEmitter, NativeModules } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  FileSource,
  FileDestination,
  CopyFileOptions,
  CopyFileResult,
  ResolvedFileRef,
  SaveTextOptions,
  ShareFileOptions,
  FileIOProgressEvent,
} from './types';
import { FileIOErrorCode } from './types';
import {
  assertFileDestinationSupportedOnPlatform,
  assertFileLocationsSupportedOnPlatform,
  assertFileSourceSupportedOnPlatform,
} from './platformValidation';

// Re-export all types
export type {
  FileSource,
  FileSourceAutoTryTarget,
  FileDestination,
  AppBaseDir,
  ResolvedFileRef,
  CopyFileOptions,
  CopyFileResult,
  SaveTextOptions,
  ShareFileOptions,
  FileIOProgressEvent,
  FileIOErrorCodeValue,
} from './types';

export { FileIOErrorCode } from './types';
export {
  assertFileDestinationSupportedOnPlatform,
  assertFileLocationsSupportedOnPlatform,
  assertFileSourceSupportedOnPlatform,
  createFileIOError,
} from './platformValidation';

let eventEmitter: NativeEventEmitter | null = null;
function getEventEmitter(): NativeEventEmitter {
  if (!eventEmitter) {
    eventEmitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
  }
  return eventEmitter;
}

let idCounter = 0;
function generateOperationId(): string {
  return `fio_${Date.now()}_${++idCounter}`;
}

function parseResolvedFileRef(result: {
  outputKind: string;
  outputPath: string;
}): ResolvedFileRef {
  if (result.outputKind === 'contentUri') {
    return { kind: 'contentUri', uri: result.outputPath };
  }
  return { kind: 'fs', path: result.outputPath };
}

/**
 * Copy a file from source to destination.
 *
 * All source/destination resolution, streaming, and error handling happens natively.
 * A single TurboModule call — no intermediate JS bridge hops.
 *
 * @throws FileIOError with code FILEIO_CANCELLED if signal is aborted.
 */
export async function copyFile(
  input: FileSource,
  output: FileDestination,
  options?: CopyFileOptions
): Promise<CopyFileResult> {
  if (input.kind === 'auto') {
    throw Object.assign(
      new Error(
        "FileSource kind 'auto' is for model path resolution only. Pass a concrete source to copyFile."
      ),
      { code: FileIOErrorCode.INVALID_ARGUMENT }
    );
  }
  assertFileLocationsSupportedOnPlatform(input, output);

  const operationId = generateOperationId();
  const overwrite = options?.overwrite ?? true;
  const createParentDirectories = options?.createParentDirectories ?? false;

  let progressSubscription: { remove: () => void } | null = null;
  let abortHandler: (() => void) | null = null;

  try {
    // Set up progress listener
    if (options?.onProgress) {
      const emitter = getEventEmitter();
      const onProgress = options.onProgress;
      progressSubscription = emitter.addListener('fileIOProgress', ((
        event: FileIOProgressEvent & { operationId: string }
      ) => {
        if (event.operationId === operationId) {
          onProgress({
            bytesTransferred: event.bytesTransferred,
            totalBytes: event.totalBytes,
            percent: event.percent,
          });
        }
      }) as any);
    }

    // Set up AbortSignal
    if (options?.signal) {
      if (options.signal.aborted) {
        throw Object.assign(new Error('Operation cancelled'), {
          code: 'FILEIO_CANCELLED',
        });
      }
      abortHandler = () => {
        SherpaOnnx.cancelFileIO(operationId);
      };
      options.signal.addEventListener('abort', abortHandler);
    }

    const result = await SherpaOnnx.copyFile(
      input as any,
      output as any,
      overwrite,
      createParentDirectories,
      operationId
    );

    return {
      bytesCopied: result.bytesCopied,
      output: parseResolvedFileRef(result),
    };
  } finally {
    progressSubscription?.remove();
    if (abortHandler && options?.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  }
}

/**
 * Write a string to a file destination.
 *
 * For contentTree destinations, the mimeType from the destination is used
 * for SAF document creation.
 */
export async function saveText(
  text: string,
  output: FileDestination,
  options?: SaveTextOptions
): Promise<ResolvedFileRef> {
  const encoding = options?.encoding ?? 'utf8';
  const overwrite = options?.overwrite ?? true;

  assertFileDestinationSupportedOnPlatform(output);

  const result = await SherpaOnnx.saveText(
    text,
    output as any,
    encoding,
    overwrite
  );

  return parseResolvedFileRef(result);
}

/**
 * Open the system share sheet for a file.
 *
 * Side-effect only — returns void.
 */
export async function shareFile(
  input: FileSource,
  options?: ShareFileOptions
): Promise<void> {
  if (input.kind === 'auto') {
    throw Object.assign(
      new Error(
        "FileSource kind 'auto' is for model path resolution only. Pass a concrete source to shareFile."
      ),
      { code: FileIOErrorCode.INVALID_ARGUMENT }
    );
  }
  assertFileSourceSupportedOnPlatform(input);

  await SherpaOnnx.shareFile(
    input as any,
    options?.mimeType ?? '',
    options?.title ?? ''
  );
}
