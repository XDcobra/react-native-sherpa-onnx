/**
 * Offline ImageBuffer — public API for react-native-sherpa-onnx/imagebuffer.
 *
 * Multi-frame RGB8 buffers with RAM|mmap storage.
 * LiveImageBuffer is reserved (types only).
 */

import {
  NativeEventEmitter,
  NativeModules,
  TurboModuleRegistry,
} from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';
import { ImageErrorCode } from './types';
import type {
  CreateOfflineImageBufferOptions,
  ImageProgressEvent,
  ImageStorageKind,
  LiveImageBufferInfo,
  OfflineImageBufferHandle,
  OfflineImageBufferIdSource,
  OfflineImageBufferInfo,
  OfflineImageBufferRef,
  OfflineImageFrameInfo,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

type NativeSubscription = { remove: () => void };

let opIdCounter = 0;

const IMAGE_BUFFER_ID_PATTERN =
  /^img_off_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function asHandle(id: string): OfflineImageBufferHandle {
  return id as OfflineImageBufferHandle;
}

function resolveImageBufferId(source: OfflineImageBufferIdSource): string {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object') {
    if (
      'bufferId' in source &&
      typeof (source as { bufferId: unknown }).bufferId === 'string'
    ) {
      const id = (source as { bufferId: string }).bufferId;
      return id;
    }
  }
  throw new Error(
    `${ImageErrorCode.INVALID_ARGUMENT}: invalid ImageBuffer id source`
  );
}

/** Resolve ref/handle/string to a native offline image buffer id. */
export function resolveOfflineImageBufferId(
  source: OfflineImageBufferIdSource
): string {
  return resolveImageBufferId(source);
}

function assertImageBufferId(id: string): void {
  if (!IMAGE_BUFFER_ID_PATTERN.test(id)) {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: malformed image buffer id: ${id}`
    );
  }
}

function mapInfo(raw: {
  bufferId: string;
  kind: string;
  state: string;
  frameCount: number;
  totalBytes: number;
  storageKind: string;
}): OfflineImageBufferInfo {
  return {
    bufferId: raw.bufferId,
    kind: 'offlineImageBuffer',
    state: 'immutable',
    frameCount: raw.frameCount,
    totalBytes: raw.totalBytes,
    storageKind: raw.storageKind === 'mmap' ? 'mmap' : 'ram',
  };
}

function toRef(info: OfflineImageBufferInfo): OfflineImageBufferRef {
  return { info, bufferId: asHandle(info.bufferId) };
}

function cancelledError(): Error {
  return Object.assign(new Error(`${ImageErrorCode.CANCELLED}: cancelled`), {
    code: ImageErrorCode.CANCELLED,
  });
}

/** Wire onProgress / AbortSignal; returns native `{ maxSide?, operationId }` plus cleanup. */
function beginCreateProgressCancel(options?: CreateOfflineImageBufferOptions): {
  nativeOptions: { maxSide?: number; operationId: string };
  cleanup: () => void;
} {
  const operationId = `img_create_${Date.now()}_${++opIdCounter}`;
  const nativeOptions: { maxSide?: number; operationId: string } = {
    operationId,
  };
  if (options?.maxSide !== undefined) {
    nativeOptions.maxSide = options.maxSide;
  }

  let progressSubscription: NativeSubscription | null = null;
  let abortHandler: (() => void) | null = null;

  if (options?.onProgress) {
    const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
    const onProgress = options.onProgress;
    progressSubscription = emitter.addListener(
      'SherpaOnnxImageProgress',
      (event: any) => {
        if (event?.operationId === operationId) {
          onProgress({
            done: event.done,
            total: event.total,
            phase: event.phase,
          });
        }
      }
    );
  }

  if (options?.signal) {
    if (options.signal.aborted) {
      progressSubscription?.remove();
      throw cancelledError();
    }
    abortHandler = () => {
      getNative()
        .cancelOfflineImageBufferCreate(operationId)
        .catch(() => {});
    };
    options.signal.addEventListener('abort', abortHandler);
  }

  return {
    nativeOptions,
    cleanup: () => {
      progressSubscription?.remove();
      if (abortHandler && options?.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
    },
  };
}

function mapCreateError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes('ERR_IMAGE_CANCELLED') ||
    msg.includes(ImageErrorCode.CANCELLED) ||
    /\bcancelled\b/i.test(msg)
  ) {
    throw cancelledError();
  }
  throw err;
}

export async function createEmptyOfflineImageBuffer(): Promise<OfflineImageBufferRef> {
  const raw = await getNative().createEmptyOfflineImageBuffer();
  const info = mapInfo(raw);
  assertImageBufferId(info.bufferId);
  if (__DEV__) {
    console.log('[SherpaOnnx:image] createEmpty', info.bufferId);
  }
  return toRef(info);
}

/**
 * Decode one or more images from {@link FileSource}(s) into an offline ImageBuffer.
 * Pass `onProgress` and/or `signal` in options for create progress and cancellation.
 */
export async function createOfflineImageBufferFromFiles(
  sources: FileSource | FileSource[],
  options?: CreateOfflineImageBufferOptions
): Promise<OfflineImageBufferRef> {
  const list = Array.isArray(sources) ? sources : [sources];
  if (list.length === 0) {
    throw new Error(`${ImageErrorCode.INVALID_ARGUMENT}: sources required`);
  }
  for (const s of list) {
    if (
      !s ||
      typeof s !== 'object' ||
      typeof (s as FileSource).kind !== 'string'
    ) {
      throw new Error(
        `${ImageErrorCode.INVALID_ARGUMENT}: each source must be a FileSource`
      );
    }
  }

  const { nativeOptions, cleanup } = beginCreateProgressCancel(options);
  try {
    const raw = await getNative().createOfflineImageBufferFromFiles(
      list as Object[],
      nativeOptions
    );
    const info = mapInfo(raw);
    assertImageBufferId(info.bufferId);
    if (__DEV__) {
      console.log(
        '[SherpaOnnx:image] createFromFiles',
        info.bufferId,
        'frames=',
        info.frameCount,
        'storage=',
        info.storageKind,
        'sources=',
        list.length
      );
    }
    return toRef(info);
  } catch (err) {
    mapCreateError(err);
  } finally {
    cleanup();
  }
}

export async function createOfflineImageBufferFromBase64(
  base64List: string[],
  options?: CreateOfflineImageBufferOptions
): Promise<OfflineImageBufferRef> {
  if (!Array.isArray(base64List) || base64List.length === 0) {
    throw new Error(`${ImageErrorCode.INVALID_ARGUMENT}: base64List required`);
  }

  const { nativeOptions, cleanup } = beginCreateProgressCancel(options);
  try {
    const raw = await getNative().createOfflineImageBufferFromBase64(
      base64List,
      nativeOptions
    );
    const info = mapInfo(raw);
    assertImageBufferId(info.bufferId);
    return toRef(info);
  } catch (err) {
    mapCreateError(err);
  } finally {
    cleanup();
  }
}

export async function getOfflineImageBufferInfo(
  buffer: OfflineImageBufferIdSource
): Promise<OfflineImageBufferInfo> {
  const id = resolveImageBufferId(buffer);
  assertImageBufferId(id);
  return mapInfo(await getNative().getOfflineImageBufferInfo(id));
}

export async function getOfflineImageBufferFrameInfo(
  buffer: OfflineImageBufferIdSource,
  frameIndex: number
): Promise<OfflineImageFrameInfo> {
  const id = resolveImageBufferId(buffer);
  assertImageBufferId(id);
  const raw = await getNative().getOfflineImageBufferFrameInfo(id, frameIndex);
  const frame: OfflineImageFrameInfo = {
    index: raw.index,
    width: raw.width,
    height: raw.height,
    byteSize: raw.byteSize,
    storageKind: raw.storageKind === 'mmap' ? 'mmap' : 'ram',
  };
  if (
    raw.pageNumber != null &&
    Number.isFinite(raw.pageNumber) &&
    raw.pageNumber > 0
  ) {
    frame.pageNumber = Math.trunc(raw.pageNumber);
  }
  if (raw.dpi != null && Number.isFinite(raw.dpi) && raw.dpi > 0) {
    frame.dpi = Math.trunc(raw.dpi);
  }
  return frame;
}

export async function releaseOfflineImageBuffer(
  buffer: OfflineImageBufferIdSource
): Promise<void> {
  const id = resolveImageBufferId(buffer);
  assertImageBufferId(id);
  await getNative().releaseOfflineImageBuffer(id);
  if (__DEV__) {
    console.log('[SherpaOnnx:image] release', id);
  }
}

export type {
  CreateOfflineImageBufferOptions,
  FileSource,
  ImageProgressEvent,
  OfflineImageBufferHandle,
  OfflineImageBufferIdSource,
  OfflineImageBufferInfo,
  OfflineImageBufferRef,
  OfflineImageFrameInfo,
  LiveImageBufferInfo,
  ImageStorageKind,
};

export { ImageErrorCode };
