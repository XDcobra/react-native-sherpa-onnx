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
  const raw = await getNative().createOfflineImageBufferFromFiles(
    list as Object[],
    options ?? {}
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
}

export async function createOfflineImageBufferFromBase64(
  base64List: string[],
  options?: CreateOfflineImageBufferOptions
): Promise<OfflineImageBufferRef> {
  if (!Array.isArray(base64List) || base64List.length === 0) {
    throw new Error(`${ImageErrorCode.INVALID_ARGUMENT}: base64List required`);
  }
  const raw = await getNative().createOfflineImageBufferFromBase64(
    base64List,
    options ?? {}
  );
  const info = mapInfo(raw);
  assertImageBufferId(info.bufferId);
  return toRef(info);
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
  return {
    index: raw.index,
    width: raw.width,
    height: raw.height,
    byteSize: raw.byteSize,
    storageKind: raw.storageKind === 'mmap' ? 'mmap' : 'ram',
  };
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

export async function cancelOfflineImageBufferCreate(
  operationId: string
): Promise<void> {
  if (!operationId) {
    throw new Error(`${ImageErrorCode.INVALID_ARGUMENT}: operationId required`);
  }
  await getNative().cancelOfflineImageBufferCreate(operationId);
}

/** Subscribe to create progress (`SherpaOnnxImageProgress`). */
export function addImageProgressListener(
  listener: (event: ImageProgressEvent) => void
): () => void {
  const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
  const sub = emitter.addListener('SherpaOnnxImageProgress', (event: any) => {
    listener(event as ImageProgressEvent);
  });
  return () => sub.remove();
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
