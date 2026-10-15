/**
 * Offline ImageBuffer types for react-native-sherpa-onnx/imagebuffer.
 *
 * LiveImageBuffer is reserved for a future epic (types only).
 */

import type { FileSource } from '../fileio/types';

export type { FileSource };

export type OfflineImageBufferState = 'immutable';

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
  BUFFER_NOT_FOUND: 'ERR_IMAGE_BUFFER_NOT_FOUND',
  CANCELLED: 'ERR_IMAGE_CANCELLED',
  INTERNAL: 'ERR_IMAGE_INTERNAL',
} as const;
