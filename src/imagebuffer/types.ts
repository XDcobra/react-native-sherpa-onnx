/**
 * Offline ImageBuffer types for react-native-sherpa-onnx/imagebuffer.
 *
 * LiveImageBuffer is reserved for a future epic (types only).
 */

import type {
  FileDestination,
  FileSource,
  ResolvedFileRef,
} from '../fileio/types';

export type { FileDestination, FileSource, ResolvedFileRef };

/** `lazy` = PDF lazy-lru slots (RGB may be cold until ensure). */
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
  | string;

/** Options for offline image create. */
export interface CreateOfflineImageBufferOptions {
  /** Longest edge cap after decode (default 4096). <= 0 disables. */
  maxSide?: number;
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

/** Reserved — not implemented in this epic. */
export type LiveImageBufferInfo = {
  bufferId: string;
  kind: 'liveImageBuffer';
};

export const ImageErrorCode = {
  INVALID_ARGUMENT: 'ERR_IMAGE_INVALID_ARGUMENT',
  DECODE_FAILED: 'ERR_IMAGE_DECODE_FAILED',
  FORMAT_UNSUPPORTED: 'ERR_IMAGE_FORMAT_UNSUPPORTED',
  WEBP_DISABLED: 'ERR_IMAGE_WEBP_DISABLED',
  BUFFER_NOT_FOUND: 'ERR_IMAGE_BUFFER_NOT_FOUND',
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
