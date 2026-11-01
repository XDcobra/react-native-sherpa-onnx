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
  ConfigureFileIOOptions,
} from './types';
import { FileIOErrorCode } from './types';
import {
  assertFileDestinationSupportedOnPlatform,
  assertFileLocationsSupportedOnPlatform,
  assertFileSourceSupportedOnPlatform,
  createFileIOError,
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
  NoFdCacheOptions,
  ConfigureFileIOOptions,
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
 * @throws {Error} `FILEIO_INVALID_ARGUMENT` — `kind: 'auto'` or a malformed location.
 * @throws {Error} `FILEIO_UNSUPPORTED_ON_PLATFORM` — source or destination kind is not valid on this OS.
 * @throws {Error} `FILEIO_CANCELLED` — `signal` aborted before or during the copy.
 * @throws {Error} `FILEIO_NOT_FOUND` — source path or URI does not exist.
 * @throws {Error} `FILEIO_PERMISSION_DENIED` — missing SAF / security-scoped permission.
 * @throws {Error} `FILEIO_ALREADY_EXISTS` — destination exists and `overwrite` is false.
 * @throws {Error} `FILEIO_READ_ERROR` — native read from the source failed.
 * @throws {Error} `FILEIO_WRITE_ERROR` — native write to the destination failed.
 * @throws {Error} `FILEIO_RESOLVE_ERROR` — source or destination could not be opened.
 * @throws {Error} `FILEIO_PATH_TRAVERSAL_BLOCKED` — `app` path escaped the base dir whitelist.
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
 *
 * @throws {Error} `FILEIO_INVALID_ARGUMENT` — malformed destination.
 * @throws {Error} `FILEIO_UNSUPPORTED_ON_PLATFORM` — destination kind is not valid on this OS.
 * @throws {Error} `FILEIO_PERMISSION_DENIED` — missing SAF / security-scoped permission.
 * @throws {Error} `FILEIO_ALREADY_EXISTS` — destination exists and `overwrite` is false.
 * @throws {Error} `FILEIO_WRITE_ERROR` — native write failed.
 * @throws {Error} `FILEIO_RESOLVE_ERROR` — destination could not be opened.
 * @throws {Error} `FILEIO_PATH_TRAVERSAL_BLOCKED` — `app` path escaped the base dir whitelist.
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
 *
 * @throws {Error} `FILEIO_INVALID_ARGUMENT` — `kind: 'auto'` or a malformed source.
 * @throws {Error} `FILEIO_UNSUPPORTED_ON_PLATFORM` — source kind is not valid on this OS.
 * @throws {Error} `FILEIO_NOT_FOUND` — source path or URI does not exist.
 * @throws {Error} `FILEIO_PERMISSION_DENIED` — missing SAF / security-scoped permission.
 * @throws {Error} `FILEIO_READ_ERROR` — native could not open the file for sharing.
 * @throws {Error} `FILEIO_RESOLVE_ERROR` — source could not be opened.
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

function assertNonNegInt(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw createFileIOError(
      FileIOErrorCode.INVALID_ARGUMENT,
      `${name} must be an integer >= ${min}`
    );
  }
}

/**
 * Configure the stream-only demux cache (`fileio_nofd`).
 * Default: 512 MiB LRU and 24 h max age. Unpinned files only; `apkAsset` is unchanged.
 *
 * @throws {Error} `FILEIO_INVALID_ARGUMENT` — `noFdCache` is not an object, or `maxBytes` / `maxAgeMs` is out of range.
 */
export async function configureFileIO(
  options?: ConfigureFileIOOptions
): Promise<void> {
  const cache = options?.noFdCache;
  if (cache != null) {
    if (typeof cache !== 'object' || Array.isArray(cache)) {
      throw createFileIOError(
        FileIOErrorCode.INVALID_ARGUMENT,
        'noFdCache must be an object'
      );
    }
    if (cache.maxBytes !== undefined) {
      if (!Number.isInteger(cache.maxBytes) || cache.maxBytes <= 0) {
        throw createFileIOError(
          FileIOErrorCode.INVALID_ARGUMENT,
          'noFdCache.maxBytes must be an integer > 0'
        );
      }
    }
    if (cache.maxAgeMs !== undefined) {
      assertNonNegInt('noFdCache.maxAgeMs', cache.maxAgeMs, 0);
    }
  }
  await SherpaOnnx.configureFileIO((options ?? {}) as Object);
}
