import type { FileSource } from '../fileio/types';
import type { OfflineImageBufferHandle } from '../imagebuffer/types';
import type {
  OfflineTextBufferHandle,
  OfflineTextBufferIdSource,
} from '../textbuffer/types';

export type { FileSource };
export type { OfflineImageBufferHandle };
export type { OfflineTextBufferHandle, OfflineTextBufferIdSource };

export const DocumentErrorCode = {
  ARCHIVE_DISABLED: 'ERR_DOC_ARCHIVE_DISABLED',
  UNSUPPORTED_FORMAT: 'ERR_DOC_UNSUPPORTED_FORMAT',
  DRM: 'ERR_DOC_DRM',
  OPEN_FAILED: 'ERR_DOC_OPEN_FAILED',
  NO_TEXT: 'ERR_DOC_NO_TEXT',
  NO_IMAGES: 'ERR_DOC_NO_IMAGES',
  INVALID_ARGUMENT: 'ERR_DOC_INVALID_ARGUMENT',
  CANCELLED: 'ERR_DOC_CANCELLED',
  PARSE_FAILED: 'ERR_DOC_PARSE_FAILED',
} as const;

export type DocumentErrorCodeValue =
  (typeof DocumentErrorCode)[keyof typeof DocumentErrorCode];

export type DocumentTextFormat = 'epub' | 'fb2' | 'mobi';
export type DocumentImageFormat = 'epub' | 'fb2' | 'mobi' | 'cbz' | 'cbr';

export type DocumentSectionKind = 'text' | 'image';

export type DocumentSectionInfo = {
  /** 0-based reading order (linear spine / FB2 body / comic page). */
  sectionIndex: number;
  /** EPUB path / FB2 id / MOBI part / archive path. */
  href?: string;
  kind: DocumentSectionKind;
};

export type ExtractDocumentTextOptions = {
  signal?: AbortSignal;
  onProgress?: (event: { done: number; total: number; phase: string }) => void;
};

export type ExtractDocumentTextResult = {
  /** Same handle as `textOut`. */
  buffer: OfflineTextBufferHandle;
  format: DocumentTextFormat;
  sectionCount: number;
  sections: DocumentSectionInfo[];
  imageOnlySections: DocumentSectionInfo[];
  spatialSpanCount: number;
};

export type ExtractDocumentImagesOptions = {
  /** Longest-edge cap after decode (default 4096). <= 0 disables. */
  maxSide?: number;
  signal?: AbortSignal;
  onProgress?: (event: { done: number; total: number; phase: string }) => void;
};

export type ExtractDocumentImagesResult = {
  buffer: OfflineImageBufferHandle;
  format: DocumentImageFormat;
  frameCount: number;
};
