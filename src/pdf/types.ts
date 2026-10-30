import type { FileSource } from '../fileio/types';
import type { OfflineImageBufferRef } from '../imagebuffer/types';
import type { OfflineTextBufferIdSource } from '../textbuffer/types';

export type { FileSource };
export type { OfflineTextBufferIdSource };
export type { OfflineImageBufferRef };

export const PdfErrorCode = {
  PDFIUM_DISABLED: 'ERR_PDF_PDFIUM_DISABLED',
  INVALID_ARGUMENT: 'ERR_PDF_INVALID_ARGUMENT',
  OPEN_FAILED: 'ERR_PDF_OPEN_FAILED',
  ENCRYPTED: 'ERR_PDF_ENCRYPTED',
  NO_TEXT_LAYER: 'ERR_PDF_NO_TEXT_LAYER',
  CANCELLED: 'ERR_PDF_CANCELLED',
  RENDER_FAILED: 'ERR_PDF_RENDER_FAILED',
  INTERNAL: 'ERR_PDF_INTERNAL',
} as const;

export type PdfErrorCodeValue =
  (typeof PdfErrorCode)[keyof typeof PdfErrorCode];

export type ExtractPdfTextLayerOptions = {
  /** 1-based page indices. Omit or `'all'` for every page. */
  pages?: 'all' | number[];
  /**
   * User or owner password for standard PDF encryption.
   * Missing or wrong → `ERR_PDF_ENCRYPTED`. Not logged.
   */
  password?: string;
  signal?: AbortSignal;
  onProgress?: (event: { done: number; total: number; phase: string }) => void;
};

export type ExtractPdfTextLayerResult = {
  pageCount: number;
  pagesWithText: number;
  utf16Length: number;
  spatialSpanCount: number;
};

/** How PDF pages become OfflineImageBuffer frames. */
export type RasterizePdfStrategy = 'rasterize-all' | 'lazy-lru';

export type RasterizePdfPagesOptions = {
  /** 1-based page indices. Omit or `'all'` for every page. */
  pages?: 'all' | number[];
  /** Render DPI (default 144). */
  dpi?: number;
  /** Longest-edge cap after DPI scale (default 4096). <= 0 disables. */
  maxSide?: number;
  /**
   * `rasterize-all` (default): decode all selected pages up front (`state: 'immutable'`).
   * `lazy-lru`: cold slots + retained PDFium doc; at most `hotFrames` RGB pages (`state: 'lazy'`).
   */
  strategy?: RasterizePdfStrategy;
  /**
   * Max decoded RGB pages retained for `lazy-lru` (default 8, clamped 1..32).
   * Ignored for `rasterize-all`.
   */
  hotFrames?: number;
  /**
   * User or owner password for standard PDF encryption.
   * Missing or wrong → `ERR_PDF_ENCRYPTED`. Not logged.
   */
  password?: string;
  signal?: AbortSignal;
  onProgress?: (event: { done: number; total: number; phase: string }) => void;
};

export type RasterizePdfPagesResult = OfflineImageBufferRef & {
  /** Document page count (not necessarily equal to frameCount). */
  pageCount: number;
};
