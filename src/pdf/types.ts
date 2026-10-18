import type { FileSource } from '../fileio/types';
import type { OfflineTextBufferIdSource } from '../textbuffer/types';

export type { FileSource };
export type { OfflineTextBufferIdSource };

export const PdfErrorCode = {
  PDFIUM_DISABLED: 'ERR_PDF_PDFIUM_DISABLED',
  INVALID_ARGUMENT: 'ERR_PDF_INVALID_ARGUMENT',
  OPEN_FAILED: 'ERR_PDF_OPEN_FAILED',
  ENCRYPTED: 'ERR_PDF_ENCRYPTED',
  NO_TEXT_LAYER: 'ERR_PDF_NO_TEXT_LAYER',
  CANCELLED: 'ERR_PDF_CANCELLED',
  INTERNAL: 'ERR_PDF_INTERNAL',
} as const;

export type PdfErrorCodeValue =
  (typeof PdfErrorCode)[keyof typeof PdfErrorCode];

export type ExtractPdfTextLayerOptions = {
  /** 1-based page indices. Omit or `'all'` for every page. */
  pages?: 'all' | number[];
  signal?: AbortSignal;
  onProgress?: (event: { done: number; total: number; phase: string }) => void;
};

export type ExtractPdfTextLayerResult = {
  pageCount: number;
  pagesWithText: number;
  utf16Length: number;
  spatialSpanCount: number;
};
