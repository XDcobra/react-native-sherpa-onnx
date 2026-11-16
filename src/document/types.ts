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
  LEXBOR_DISABLED: 'ERR_DOC_LEXBOR_DISABLED',
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

/** Container format by content (`detectDocumentFormat`). MOBI includes AZW3. */
export type DocumentFileFormat =
  | 'epub'
  | 'fb2'
  | 'mobi'
  | 'cbz'
  | 'cbr'
  | 'pdf';

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

/** Format of a reading structure: the e-book formats and PDF (`extractPdfTextLayer`). */
export type DocumentStructureFormat = DocumentTextFormat | 'pdf';

/** One section of the reading structure (docs/reader.md). */
export type DocumentStructureSection = {
  sectionIndex: number;
  /** EPUB path / FB2 id / MOBI part; `page:N` for a PDF page. */
  href: string;
  /** `'page'`: one PDF page (its page image is the section's first block). */
  kind: DocumentSectionKind | 'page';
  /** From the table of contents, else the first heading. */
  title?: string;
  titleSource: 'toc' | 'heading' | 'none';
  /** Printed page label of a PDF page (`"iv"`, `"12"`), when the PDF has one. */
  label?: string;
  /** UTF-16 range of the section's text in the buffer (empty if it has none). */
  utf16Start: number;
  utf16End: number;
  /** Index of the section's first block in the structure. */
  firstBlock: number;
  blockCount: number;
};

/**
 * Reading structure attached to the text buffer (EPUB, FB2, MOBI / AZW3, and
 * PDF with `layout: 'paragraphs'`). Blocks stay in native memory; read them
 * through the reader API (`react-native-sherpa-onnx/reader`).
 */
export type DocumentStructure = {
  /** Source format; its structure rules are versioned on their own. */
  format: DocumentStructureFormat;
  version: number;
  blockCount: number;
  sections: DocumentStructureSection[];
  metadata: { title?: string; creator?: string; language?: string };
};

export type ExtractDocumentTextResult = {
  /** Same handle as `textOut`. */
  buffer: OfflineTextBufferHandle;
  format: DocumentTextFormat;
  sectionCount: number;
  sections: DocumentSectionInfo[];
  imageOnlySections: DocumentSectionInfo[];
  spatialSpanCount: number;
  /** EPUB only: reading structure summary (sections, titles, metadata). */
  structure?: DocumentStructure;
};

export type ExtractDocumentImagesOptions = {
  /** Longest-edge cap after decode (default 4096). <= 0 disables. */
  maxSide?: number;
  /**
   * `'imageSections'` (default): image-only sections / comic pages.
   * `'all'` (EPUB): also images inside text sections, one frame per unique
   * image path, in reading order (frame `href` = archive path). Used by the
   * reader for image blocks.
   */
  scope?: 'imageSections' | 'all';
  /**
   * `'decode-all'` (default): every image is decoded now. `'lazy-lru'`: comic
   * pages (CBZ / CBR) stay in the archive and are decoded when a frame is
   * needed, at most `hotFrames` at a time; frame sizes are known up front
   * (`expectedWidth` / `expectedHeight`). The file stays open until the buffer
   * is released. Other formats decode as with `'decode-all'`.
   */
  strategy?: 'decode-all' | 'lazy-lru';
  /** `'lazy-lru'` only: decoded frames kept in memory (default 8, clamped 1..32). */
  hotFrames?: number;
  signal?: AbortSignal;
  onProgress?: (event: { done: number; total: number; phase: string }) => void;
};

export type ExtractDocumentImagesResult = {
  buffer: OfflineImageBufferHandle;
  format: DocumentImageFormat;
  frameCount: number;
};
