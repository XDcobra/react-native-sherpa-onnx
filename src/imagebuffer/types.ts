/**
 * Pipeline image buffer types for react-native-sherpa-onnx/imagebuffer.
 *
 * OfflineImageBuffer: immutable RGB or lazy file/PDF slots.
 * LiveImageBuffer: recording → finished (never back). Same C++ kernel.
 */

import type {
  FileDestination,
  FileSource,
  ResolvedFileRef,
} from '../fileio/types';

export type { FileDestination, FileSource, ResolvedFileRef };

/** `lazy` = PDF or file lazy-lru slots (RGB may be cold until ensure). */
export type OfflineImageBufferState = 'immutable' | 'lazy';

export type ImageStorageKind = 'ram' | 'mmap';

export interface OfflineImageBufferInfo {
  bufferId: string;
  kind: 'offlineImageBuffer';
  state: OfflineImageBufferState;
  frameCount: number;
  totalBytes: number;
  storageKind: ImageStorageKind;
}

export interface OfflineImageFrameInfo {
  index: number;
  width: number;
  height: number;
  byteSize: number;
  storageKind: ImageStorageKind;
  /** 1-based PDF page number when frame came from rasterizePdfPages. */
  pageNumber?: number;
  /** Raster DPI when frame came from rasterizePdfPages. */
  dpi?: number;
  /** 0-based document section (EPUB image-only item / comic page). */
  sectionIndex?: number;
  /** EPUB path or archive member path. */
  href?: string;
  /** Optional VideoBuffer origin (createOfflineImageBufferFromVideo). */
  source?: {
    videoBufferId: string;
    ptsUs: number;
    frameIndex: number;
  };
}

/** Branded handle for an offline image buffer. */
export type OfflineImageBufferHandle = string & {
  readonly __brand: 'OfflineImageBufferHandle';
};

export interface OfflineImageBufferRef {
  info: OfflineImageBufferInfo;
  bufferId: OfflineImageBufferHandle;
}

export type OfflineImageBufferIdSource =
  | OfflineImageBufferRef
  | OfflineImageBufferHandle
  | OfflineImageBufferInfo
  | LiveImageBufferFinishedRef
  | LiveImageBufferHandleFinished
  | string;

/** Options for offline image create. */
export interface CreateOfflineImageBufferOptions {
  /** Longest edge cap after decode (default 4096). <= 0 disables. */
  maxSide?: number;
  /**
   * Lazy file create: max decoded RGB frames kept hot (default 8, clamped 1..32).
   * Same contract as PDF `hotFrames`.
   */
  hotFrames?: number;
  /**
   * Cancel the create operation. When aborted, the create promise rejects with
   * `ERR_IMAGE_CANCELLED` and any partial buffer is released.
   */
  signal?: AbortSignal;
  /**
   * Progress during multi-file / multi-blob create.
   * `done`/`total` count sources; `phase` is e.g. `decode` or `done`.
   */
  onProgress?: (event: ImageProgressEvent) => void;
}

/** Progress event for offline image create (public; no operationId). */
export interface ImageProgressEvent {
  done: number;
  total: number;
  phase: string;
}

export type PipelineImageBufferKind = 'offlineImageBuffer' | 'liveImageBuffer';

export type LiveImageBufferState = 'recording' | 'finished';

export interface LiveImageBufferInfo {
  bufferId: string;
  kind: 'liveImageBuffer';
  state: LiveImageBufferState;
  frameCount: number;
  totalFramesWritten: number;
  ringEvictedFrames: number;
  hasActiveSpool: boolean;
  totalBytes?: number;
  storageKind?: ImageStorageKind;
}

export type PipelineImageBufferInfo =
  | OfflineImageBufferInfo
  | LiveImageBufferInfo;

export type LiveImageBufferHandleRecording = string & {
  readonly __brand: 'LiveImageBufferHandleRecording';
};

export type LiveImageBufferHandleFinished = string & {
  readonly __brand: 'LiveImageBufferHandleFinished';
};

export type LiveImageBufferHandle =
  | LiveImageBufferHandleRecording
  | LiveImageBufferHandleFinished;

export interface LiveImageBufferRef {
  info: LiveImageBufferInfo;
  bufferId: LiveImageBufferHandleRecording;
  unsubscribeEvents: () => void;
}

export type LiveImageBufferFinishedRef = {
  bufferId: LiveImageBufferHandleFinished;
  info: LiveImageBufferInfo;
};

export type LiveImageBufferIdSource =
  | LiveImageBufferRef
  | LiveImageBufferHandleRecording
  | LiveImageBufferHandleFinished
  | string;

export type PipelineImageBufferIdSource =
  | OfflineImageBufferRef
  | LiveImageBufferRef
  | PipelineImageBufferInfo
  | OfflineImageBufferHandle
  | LiveImageBufferHandle
  | string;

export type ImageRetention = 'session' | 'none';

export interface CreateEmptyLiveImageBufferOptions {
  ringFrames?: number;
  retention?: ImageRetention;
}

export type LiveImageBufferEventType =
  | 'framesAppended'
  | 'overflow'
  | 'finished';

export interface LiveImageBufferEvent {
  type: LiveImageBufferEventType;
  liveBufferId: string;
  frameCount?: number;
  totalFramesWritten?: number;
}

export const ImageErrorCode = {
  INVALID_ARGUMENT: 'ERR_IMAGE_INVALID_ARGUMENT',
  DECODE_FAILED: 'ERR_IMAGE_DECODE_FAILED',
  FORMAT_UNSUPPORTED: 'ERR_IMAGE_FORMAT_UNSUPPORTED',
  WEBP_DISABLED: 'ERR_IMAGE_WEBP_DISABLED',
  BUFFER_NOT_FOUND: 'ERR_IMAGE_BUFFER_NOT_FOUND',
  INVALID_STATE: 'ERR_IMAGE_INVALID_STATE',
  FRAME_EVICTED: 'ERR_IMAGE_FRAME_EVICTED',
  ENCODE_FAILED: 'ERR_IMAGE_ENCODE_FAILED',
  CANCELLED: 'ERR_IMAGE_CANCELLED',
  INTERNAL: 'ERR_IMAGE_INTERNAL',
} as const;

/** Encode formats for {@link exportOfflineImageBufferFrame}. */
export type ImageExportFormat = 'jpeg' | 'png' | 'webp';

export interface ExportOfflineImageBufferFrameOptions {
  /** Default `jpeg`. */
  format?: ImageExportFormat;
  /** JPEG/WebP quality 1..100 (default 85). Ignored for PNG. */
  quality?: number;
  /** Downscale longest edge on export only; does not mutate the buffer. */
  maxSide?: number;
}

export type ImageFrameResizeMode = 'contain' | 'cover' | 'stretch';
