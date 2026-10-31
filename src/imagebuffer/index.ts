/**
 * Pipeline ImageBuffer — public API for react-native-sherpa-onnx/imagebuffer.
 *
 * Offline: multi-frame RGB8 with RAM|mmap. File/base64 create is lazy-lru
 * (`state: 'lazy'`); RGB on ensure / OCR / FrameView.
 * Live: compressed JPEG/WebP/HEIC ring (`img_live_*`), recording → finished.
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
  CreateEmptyLiveImageBufferOptions,
  CreateOfflineImageBufferOptions,
  ExportOfflineImageBufferFrameOptions,
  ImageExportFormat,
  ImageFrameResizeMode,
  ImageProgressEvent,
  ImageRetention,
  ImageStorageKind,
  LiveImageBufferEvent,
  LiveImageBufferEventType,
  LiveImageBufferFinishedRef,
  LiveImageBufferHandle,
  LiveImageBufferHandleFinished,
  LiveImageBufferHandleRecording,
  LiveImageBufferIdSource,
  LiveImageBufferInfo,
  LiveImageBufferRef,
  LiveImageBufferState,
  OfflineImageBufferHandle,
  OfflineImageBufferIdSource,
  OfflineImageBufferInfo,
  OfflineImageBufferRef,
  OfflineImageBufferState,
  OfflineImageFrameInfo,
  PipelineImageBufferIdSource,
  PipelineImageBufferInfo,
  PipelineImageBufferKind,
} from './types';
import {
  OfflineImageBufferFrameView,
  type OfflineImageBufferFrameViewProps,
} from './OfflineImageBufferFrameView';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

type NativeSubscription = { remove: () => void };

let opIdCounter = 0;

const OFFLINE_ID =
  /^img_off_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LIVE_ID =
  /^img_live_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const IMAGE_BUFFER_ID_PATTERN = new RegExp(
  `${OFFLINE_ID.source}|${LIVE_ID.source}`
);

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
  const id = resolveImageBufferId(source);
  if (!OFFLINE_ID.test(id) && !LIVE_ID.test(id)) {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: malformed image buffer id: ${id}`
    );
  }
  return id;
}

export function resolveLiveImageBufferId(
  source: LiveImageBufferIdSource
): string {
  const id = resolveImageBufferId(source as OfflineImageBufferIdSource);
  if (!LIVE_ID.test(id)) {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: malformed live image buffer id: ${id}`
    );
  }
  return id;
}

export function resolvePipelineImageBufferId(
  source: PipelineImageBufferIdSource
): string {
  const id = resolveImageBufferId(source as OfflineImageBufferIdSource);
  if (!OFFLINE_ID.test(id) && !LIVE_ID.test(id)) {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: malformed image buffer id: ${id}`
    );
  }
  return id;
}

function assertImageBufferId(id: string): void {
  if (!IMAGE_BUFFER_ID_PATTERN.test(id)) {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: malformed image buffer id: ${id}`
    );
  }
}

function mapOfflineInfo(raw: {
  bufferId: string;
  kind?: string;
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

function mapLiveInfo(raw: {
  bufferId: string;
  state: string;
  frameCount: number;
  totalFramesWritten?: number;
  ringEvictedFrames?: number;
  hasActiveSpool?: boolean | string;
  totalBytes?: number;
  storageKind?: string;
}): LiveImageBufferInfo {
  return {
    bufferId: raw.bufferId,
    kind: 'liveImageBuffer',
    state: raw.state === 'finished' ? 'finished' : 'recording',
    frameCount: raw.frameCount,
    totalFramesWritten: raw.totalFramesWritten ?? 0,
    ringEvictedFrames: raw.ringEvictedFrames ?? 0,
    hasActiveSpool:
      raw.hasActiveSpool === true || raw.hasActiveSpool === 'true',
    totalBytes: raw.totalBytes,
    storageKind:
      raw.storageKind === 'mmap'
        ? 'mmap'
        : raw.storageKind === 'ram'
        ? 'ram'
        : undefined,
  };
}

function mapInfo(raw: {
  bufferId: string;
  kind: string;
  state: string;
  frameCount: number;
  totalBytes: number;
  storageKind: string;
}): OfflineImageBufferInfo {
  return mapOfflineInfo(raw);
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
  sourceVideoBufferId?: string;
  sourcePtsUs?: number;
  sourceFrameIndex?: number;
  decoderProvider?: string;
  decoderTier?: string;
  decoderOrigin?: string;
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
  const vid =
    typeof raw.sourceVideoBufferId === 'string' ? raw.sourceVideoBufferId : '';
  if (
    vid.length > 0 &&
    raw.sourcePtsUs != null &&
    Number.isFinite(raw.sourcePtsUs)
  ) {
    frame.source = {
      videoBufferId: vid,
      ptsUs: raw.sourcePtsUs,
      frameIndex:
        raw.sourceFrameIndex != null && Number.isFinite(raw.sourceFrameIndex)
          ? Math.trunc(raw.sourceFrameIndex)
          : 0,
    };
  }
  if (
    typeof raw.decoderProvider === 'string' &&
    raw.decoderProvider.length > 0
  ) {
    frame.decoder = {
      provider: raw.decoderProvider,
      tier:
        raw.decoderTier === 'hardware' || raw.decoderTier === 'software'
          ? raw.decoderTier
          : 'unknown',
      origin: raw.decoderOrigin === 'bundled' ? 'bundled' : 'platform',
    };
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

/** Wire onProgress / AbortSignal; returns native `{ maxSide?, hotFrames?, operationId }` plus cleanup. */
function beginCreateProgressCancel(options?: CreateOfflineImageBufferOptions): {
  nativeOptions: {
    maxSide?: number;
    hotFrames?: number;
    operationId: string;
    decodePolicy?: string;
  };
  cleanup: () => void;
} {
  const operationId = `img_create_${Date.now()}_${++opIdCounter}`;
  const nativeOptions: {
    maxSide?: number;
    hotFrames?: number;
    operationId: string;
    decodePolicy?: string;
  } = {
    operationId,
  };
  if (options?.maxSide !== undefined) {
    nativeOptions.maxSide = options.maxSide;
  }
  if (options?.hotFrames !== undefined) {
    nativeOptions.hotFrames = options.hotFrames;
  }
  if (options?.decodePolicy !== undefined) {
    nativeOptions.decodePolicy = options.decodePolicy;
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
 * Index one or more images from {@link FileSource}(s) into a lazy offline ImageBuffer.
 * RGB is decoded on {@link ensureOfflineImageBufferFrame}, FrameView, or OCR.
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
  if (!OFFLINE_ID.test(id)) {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: malformed offline image buffer id: ${id}`
    );
  }
  return mapInfo(await getNative().getOfflineImageBufferInfo(id));
}

function mapPipelineInfo(raw: {
  bufferId: string;
  kind?: string;
  state: string;
  frameCount: number;
  totalBytes?: number;
  storageKind?: string;
  totalFramesWritten?: number;
  ringEvictedFrames?: number;
  hasActiveSpool?: boolean | string;
}): PipelineImageBufferInfo {
  if (raw.kind === 'liveImageBuffer' || LIVE_ID.test(raw.bufferId)) {
    return mapLiveInfo(raw);
  }
  return mapOfflineInfo({
    bufferId: raw.bufferId,
    kind: raw.kind,
    state: raw.state,
    frameCount: raw.frameCount,
    totalBytes: raw.totalBytes ?? 0,
    storageKind: raw.storageKind ?? 'ram',
  });
}

export async function getPipelineImageBufferInfo(
  buffer: PipelineImageBufferIdSource
): Promise<PipelineImageBufferInfo> {
  const id = resolvePipelineImageBufferId(buffer);
  return mapPipelineInfo(await getNative().getOfflineImageBufferInfo(id));
}

export async function releasePipelineImageBuffer(
  buffer: PipelineImageBufferIdSource
): Promise<void> {
  const id = resolvePipelineImageBufferId(buffer);
  await getNative().releaseOfflineImageBuffer(id);
  if (__DEV__) {
    console.log('[SherpaOnnx:image] release', id);
  }
}

function assertFileSource(source: FileSource): void {
  if (
    !source ||
    typeof source !== 'object' ||
    typeof (source as FileSource).kind !== 'string'
  ) {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: source must be a FileSource`
    );
  }
}

export async function createEmptyLiveImageBuffer(
  options?: CreateEmptyLiveImageBufferOptions
): Promise<LiveImageBufferRef> {
  const raw = await getNative().createEmptyLiveImageBuffer({
    ringFrames: options?.ringFrames ?? 16,
    retention: options?.retention ?? 'session',
  });
  const info = mapLiveInfo(raw);
  if (!LIVE_ID.test(info.bufferId)) {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: malformed live image buffer id: ${info.bufferId}`
    );
  }
  if (__DEV__) {
    console.log(
      '[SherpaOnnx:image] createEmptyLive',
      info.bufferId,
      'ringFrames=',
      options?.ringFrames ?? 16,
      'retention=',
      options?.retention ?? 'session'
    );
  }
  return {
    info,
    bufferId: info.bufferId as LiveImageBufferHandleRecording,
    unsubscribeEvents: () => {},
  };
}

export async function appendLiveImageFrame(
  live: LiveImageBufferIdSource,
  compressedBase64: string
): Promise<LiveImageBufferInfo> {
  const id = resolveLiveImageBufferId(live);
  if (typeof compressedBase64 !== 'string' || compressedBase64.length === 0) {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: compressedBase64 required`
    );
  }
  const info = mapLiveInfo(
    await getNative().appendLiveImageFrame(id, compressedBase64)
  );
  if (__DEV__) {
    console.log(
      '[SherpaOnnx:image] appendLive',
      id,
      'frames=',
      info.frameCount,
      'written=',
      info.totalFramesWritten,
      'evicted=',
      info.ringEvictedFrames
    );
  }
  return info;
}

export async function ingestFileToLiveImageBuffer(
  source: FileSource,
  live: LiveImageBufferIdSource
): Promise<LiveImageBufferInfo> {
  assertFileSource(source);
  const id = resolveLiveImageBufferId(live);
  const info = mapLiveInfo(
    await getNative().ingestFileToLiveImageBuffer(source as Object, id)
  );
  if (__DEV__) {
    console.log(
      '[SherpaOnnx:image] ingestFileToLive',
      id,
      'kind=',
      source.kind,
      'frames=',
      info.frameCount
    );
  }
  return info;
}

export async function finalizeLiveImageBuffer(
  live: LiveImageBufferIdSource
): Promise<LiveImageBufferFinishedRef> {
  const id = resolveLiveImageBufferId(live);
  const info = mapLiveInfo(await getNative().finalizeLiveImageBuffer(id));
  if (__DEV__) {
    console.log('[SherpaOnnx:image] finalizeLive', id, 'state=', info.state);
  }
  return {
    bufferId: info.bufferId as LiveImageBufferHandleFinished,
    info,
  };
}

export function subscribeLiveImageBufferEvents(
  live: LiveImageBufferIdSource,
  onEvent: (event: LiveImageBufferEvent) => void
): () => void {
  const id = resolveLiveImageBufferId(live);
  const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
  const sub = emitter.addListener(
    'SherpaOnnxImageLiveEvent',
    (raw: {
      type?: string;
      liveBufferId?: string;
      frameCount?: number;
      totalFramesWritten?: number;
    }) => {
      if (!raw || raw.liveBufferId !== id) return;
      onEvent({
        type: (raw.type as LiveImageBufferEvent['type']) ?? 'framesAppended',
        liveBufferId: raw.liveBufferId,
        frameCount: raw.frameCount,
        totalFramesWritten: raw.totalFramesWritten,
      });
    }
  );
  return () => sub.remove();
}

export { getOfflineImageBufferFrameInfo } from './getFrameInfo';

/**
 * Ensure frame RGB is resident. No-op (returns frame info) for immutable buffers.
 * For lazy file and PDF buffers: decode/rasterize cold slots, update LRU, may prefetch ±1.
 * Finished live buffers decode a compressed ring/spool frame into the hot RGB cache.
 * Recording live buffers reject with `ERR_IMAGE_INVALID_STATE`.
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
  CreateEmptyLiveImageBufferOptions,
  CreateOfflineImageBufferOptions,
  ExportOfflineImageBufferFrameOptions,
  FileDestination,
  FileSource,
  ImageExportFormat,
  ImageFrameResizeMode,
  ImageProgressEvent,
  ImageRetention,
  ImageStorageKind,
  LiveImageBufferEvent,
  LiveImageBufferEventType,
  LiveImageBufferFinishedRef,
  LiveImageBufferHandle,
  LiveImageBufferHandleFinished,
  LiveImageBufferHandleRecording,
  LiveImageBufferIdSource,
  LiveImageBufferInfo,
  LiveImageBufferRef,
  LiveImageBufferState,
  OfflineImageBufferFrameViewProps,
  OfflineImageBufferHandle,
  OfflineImageBufferIdSource,
  OfflineImageBufferInfo,
  OfflineImageBufferRef,
  OfflineImageBufferState,
  OfflineImageFrameInfo,
  PipelineImageBufferIdSource,
  PipelineImageBufferInfo,
  PipelineImageBufferKind,
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
