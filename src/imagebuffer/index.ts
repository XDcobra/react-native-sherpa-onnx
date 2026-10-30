/**
 * Offline ImageBuffer — public API for react-native-sherpa-onnx/imagebuffer.
 *
 * Multi-frame RGB8 buffers with RAM|mmap storage.
 * LiveImageBuffer is reserved (types only).
 *
 * WebP is opt-in: rebuild with `sherpaOnnxEnableLibwebp=true` (Android) or
 * `SHERPA_ONNX_ENABLE_LIBWEBP=1` (iOS). Default builds reject WebP decode/export
 * with `ERR_IMAGE_WEBP_DISABLED`.
 */

import {
  NativeEventEmitter,
  NativeModules,
  TurboModuleRegistry,
} from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import { assertFileDestinationSupportedOnPlatform } from '../fileio';
import type {
  FileDestination,
  FileSource,
  ResolvedFileRef,
} from '../fileio/types';
import { ImageErrorCode } from './types';
import type {
  CreateOfflineImageBufferOptions,
  ExportOfflineImageBufferFrameOptions,
  ImageExportFormat,
  ImageFrameResizeMode,
  ImageProgressEvent,
  ImageStorageKind,
  LiveImageBufferInfo,
  OfflineImageBufferHandle,
  OfflineImageBufferIdSource,
  OfflineImageBufferInfo,
  OfflineImageBufferRef,
  OfflineImageBufferState,
  OfflineImageFrameInfo,
} from './types';
import {
  OfflineImageBufferFrameView,
  type OfflineImageBufferFrameViewProps,
} from './OfflineImageBufferFrameView';

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
    state: raw.state === 'lazy' ? 'lazy' : 'immutable',
    frameCount: raw.frameCount,
    totalBytes: raw.totalBytes,
    storageKind: raw.storageKind === 'mmap' ? 'mmap' : 'ram',
  };
}

function mapFrameInfo(raw: {
  index: number;
  width: number;
  height: number;
  byteSize: number;
  storageKind: string;
  pageNumber?: number;
  dpi?: number;
  sectionIndex?: number;
  href?: string;
}): OfflineImageFrameInfo {
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
  if (
    raw.sectionIndex != null &&
    Number.isFinite(raw.sectionIndex) &&
    raw.sectionIndex >= 0
  ) {
    frame.sectionIndex = Math.trunc(raw.sectionIndex);
  }
  const href = typeof raw.href === 'string' ? raw.href : '';
  if (href.length > 0) {
    frame.href = href;
  }
  return frame;
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

function mapWebpDisabled(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes(ImageErrorCode.WEBP_DISABLED) ||
    msg.includes('libwebp is not linked')
  ) {
    throw Object.assign(
      new Error(
        `${ImageErrorCode.WEBP_DISABLED}: libwebp is not linked. Rebuild with sherpaOnnxEnableLibwebp=true (Android) or SHERPA_ONNX_ENABLE_LIBWEBP=1 (iOS) and ensure libwebp prebuilts resolve.`
      ),
      { code: ImageErrorCode.WEBP_DISABLED, cause: err }
    );
  }
  throw err;
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
  mapWebpDisabled(err);
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

export { getOfflineImageBufferFrameInfo } from './getFrameInfo';

/**
 * Ensure frame RGB is resident. No-op (returns frame info) for immutable buffers.
 * For lazy-lru PDF buffers: rasterize cold slots, update LRU, may prefetch ±1.
 */
export async function ensureOfflineImageBufferFrame(
  buffer: OfflineImageBufferIdSource,
  frameIndex: number
): Promise<OfflineImageFrameInfo> {
  const id = resolveImageBufferId(buffer);
  assertImageBufferId(id);
  if (!Number.isFinite(frameIndex) || frameIndex < 0) {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: frameIndex must be a non-negative integer`
    );
  }
  const raw = await getNative().ensureOfflineImageBufferFrame(
    id,
    Math.trunc(frameIndex)
  );
  if (__DEV__) {
    console.log('[SherpaOnnx:image] ensureFrame', id, frameIndex, {
      width: raw.width,
      height: raw.height,
    });
  }
  return mapFrameInfo(raw);
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
 * Encode one frame to a {@link FileDestination} (same write model as `saveAudioAsFile`).
 * Returns a {@link ResolvedFileRef} for the written file.
 */
export async function exportOfflineImageBufferFrame(
  buffer: OfflineImageBufferIdSource,
  frameIndex: number,
  output: FileDestination,
  options?: ExportOfflineImageBufferFrameOptions
): Promise<ResolvedFileRef> {
  const id = resolveImageBufferId(buffer);
  assertImageBufferId(id);
  if (!Number.isFinite(frameIndex) || frameIndex < 0) {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: frameIndex must be a non-negative integer`
    );
  }
  assertFileDestinationSupportedOnPlatform(output);

  const format: ImageExportFormat = options?.format ?? 'jpeg';
  if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: unsupported export format: ${String(
        format
      )}`
    );
  }

  try {
    const result = await getNative().exportOfflineImageBufferFrame(
      id,
      Math.trunc(frameIndex),
      output as unknown as Object,
      {
        format,
        quality: options?.quality ?? 85,
        maxSide: options?.maxSide ?? 0,
      }
    );

    if (__DEV__) {
      console.log(
        '[SherpaOnnx:image] exportFrame',
        id,
        frameIndex,
        format,
        result
      );
    }

    return parseResolvedFileRef(result);
  } catch (err) {
    mapWebpDisabled(err);
  }
}

export type {
  CreateOfflineImageBufferOptions,
  ExportOfflineImageBufferFrameOptions,
  FileDestination,
  FileSource,
  ImageExportFormat,
  ImageFrameResizeMode,
  ImageProgressEvent,
  OfflineImageBufferFrameViewProps,
  OfflineImageBufferHandle,
  OfflineImageBufferIdSource,
  OfflineImageBufferInfo,
  OfflineImageBufferRef,
  OfflineImageBufferState,
  OfflineImageFrameInfo,
  LiveImageBufferInfo,
  ImageStorageKind,
  ResolvedFileRef,
};

export { ImageErrorCode, OfflineImageBufferFrameView };
export {
  OfflineImageBufferAnnotatedView,
  type OfflineImageBufferAnnotatedViewProps,
  type OfflineImageBufferSpanPressEvent,
  type OfflineImageBufferSpanRange,
} from './OfflineImageBufferAnnotatedView';
export {
  mapTextSpatialSpansToFrame,
  type MapTextSpatialSpansToFrameOptions,
  type MapTextSpatialSpansToFrameOrigin,
  type MappedTextSpatialSpan,
} from './mapToFrame';
