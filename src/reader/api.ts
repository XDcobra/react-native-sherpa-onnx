/**
 * Reader documents: native `rdr_*` handles built from a text buffer's reading
 * structure (EPUB, FB2, MOBI via `extractDocumentText`, PDF via
 * `extractPdfTextLayer`) or from page images (comics). See docs/reader.md.
 */
import { TurboModuleRegistry } from 'react-native';

import type { Spec } from '../NativeSherpaOnnx';
import {
  extractDocumentImages,
  extractDocumentText,
  DocumentErrorCode,
} from '../document';
import { detectDocumentFormat } from '../document/detect';
import type { FileSource } from '../fileio/types';
import { releaseOfflineImageBuffer } from '../imagebuffer';
import { extractPdfTextLayer, rasterizePdfPages } from '../pdf';
import {
  createEmptyOfflineTextBuffer,
  releasePipelineTextBuffer,
  resolveOfflineTextBufferId,
} from '../textbuffer';
import type {
  OfflineTextBufferHandle,
  OfflineTextBufferIdSource,
} from '../textbuffer/types';
import type {
  ReaderAppSection,
  ReaderBlock,
  ReaderDocument,
  ReaderDocumentFormat,
  ReaderLocator,
  ReaderRange,
  ReaderTextSlice,
  ReaderTocEntry,
  ReaderSectionInfo,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

export const ReaderErrorCode = {
  NOT_FOUND: 'ERR_READER_NOT_FOUND',
  NO_STRUCTURE: 'ERR_READER_NO_STRUCTURE',
  UNSUPPORTED_STRUCTURE: 'ERR_READER_UNSUPPORTED_STRUCTURE',
  INVALID_ARGUMENT: 'ERR_READER_INVALID_ARGUMENT',
  /** Not a reader OCR sidecar, or a corrupt one. */
  SIDECAR_INVALID: 'ERR_READER_SIDECAR_INVALID',
  /** A sidecar of another document or model, or with pages this document does not have. */
  SIDECAR_MISMATCH: 'ERR_READER_SIDECAR_MISMATCH',
} as const;

export type ReaderErrorCodeValue =
  (typeof ReaderErrorCode)[keyof typeof ReaderErrorCode];

const MAX_BLOCKS_PER_CALL = 4096;
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Image buffers created by `loadReaderDocument`, released with the document. */
const ownedImageBuffers = new Map<string, string>();

function readerError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function nativeCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.startsWith('ERR_READER_')) {
    return code;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /^(ERR_READER_[A-Z_]+)/.exec(msg)?.[1];
}

/** @internal Maps `ERR_READER_*` rejections onto `error.code`. */
export async function callNative<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const code = nativeCode(err);
    if (code) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(err instanceof Error ? err : new Error(msg), {
        code,
      });
    }
    throw err;
  }
}

/** @internal Parses the native summary JSON. */
const FORMATS: ReadonlyArray<ReaderDocumentFormat> = [
  'epub',
  'fb2',
  'mobi',
  'pdf',
  'pages',
];

function parseFormat(value: unknown): ReaderDocumentFormat {
  return FORMATS.includes(value as ReaderDocumentFormat)
    ? (value as ReaderDocumentFormat)
    : 'epub';
}

export function parseReaderDocument(json: string): ReaderDocument {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).map(
    (item): ReaderSectionInfo => {
      const s = item as Record<string, unknown>;
      const titleSource = s.titleSource;
      const out: ReaderSectionInfo = {
        id: String(s.id ?? ''),
        origin: s.origin === 'app' ? 'app' : 'file',
        kind: s.kind === 'image' || s.kind === 'page' ? s.kind : 'text',
        titleSource:
          titleSource === 'toc' ||
          titleSource === 'heading' ||
          titleSource === 'app'
            ? titleSource
            : 'none',
        blockCount: Number(s.blockCount ?? 0),
        firstBlockId: String(s.firstBlockId ?? ''),
        lastBlockId: String(s.lastBlockId ?? ''),
      };
      if (typeof s.sectionIndex === 'number') out.sectionIndex = s.sectionIndex;
      if (typeof s.href === 'string') out.href = s.href;
      if (typeof s.title === 'string' && s.title) out.title = s.title;
      if (typeof s.label === 'string' && s.label) out.label = s.label;
      return out;
    }
  );
  const meta = (raw.metadata ?? {}) as Record<string, unknown>;
  const metadata: ReaderDocument['metadata'] = {};
  if (typeof meta.title === 'string') metadata.title = meta.title;
  if (typeof meta.creator === 'string') metadata.creator = meta.creator;
  if (typeof meta.language === 'string') metadata.language = meta.language;
  return {
    id: String(raw.id ?? ''),
    revision: Number(raw.revision ?? 0),
    documentKey: String(raw.documentKey ?? ''),
    format: parseFormat(raw.format),
    structureVersion: Number(raw.structureVersion ?? 0),
    textHashVersion: Number(raw.textHashVersion ?? 0),
    blockCount: Number(raw.blockCount ?? 0),
    sections,
    metadata,
  };
}

/** Lowercase hex SHA-256 of the file (`documentKey`). */
export function computeDocumentKey(source: FileSource): Promise<string> {
  return callNative(() =>
    getNative().computeFileSourceSha256(source as Object)
  );
}

/** Options of {@link createReaderDocument}. */
export type CreateReaderDocumentOptions =
  | {
      /**
       * Text buffer with a reading structure: `extractDocumentText` (EPUB,
       * FB2, MOBI) or `extractPdfTextLayer(…, { layout: 'paragraphs' })`.
       */
      text: OfflineTextBufferIdSource;
      /**
       * Image buffer for image and page blocks:
       * `extractDocumentImages(source, { scope: 'all' })`, or for a PDF
       * `rasterizePdfPages(source, { strategy: 'lazy-lru' })` (all pages).
       */
      images?: string | { bufferId: string } | null;
      documentKey: string;
    }
  | {
      /**
       * Page images (comic pages, scans): one page section per frame, e.g.
       * `extractDocumentImages(cbz, { strategy: 'lazy-lru' })`. The pages have
       * no text until OCR text is attached.
       */
      pages: string | { bufferId: string };
      documentKey: string;
    };

function bufferIdOf(
  v: string | { bufferId: string } | null | undefined
): string {
  return v == null ? '' : typeof v === 'string' ? v : v.bufferId;
}

/**
 * Reader document from a text buffer with a reading structure (and optionally
 * its image buffer), or from page images. The document keeps the text alive;
 * the caller may release its text handle. Image buffers stay owned by the
 * caller and must outlive the document.
 */
export async function createReaderDocument(
  options: CreateReaderDocumentOptions
): Promise<ReaderDocument> {
  if ('pages' in options) {
    const pagesId = bufferIdOf(options.pages);
    if (!pagesId) {
      throw readerError(
        ReaderErrorCode.INVALID_ARGUMENT,
        'pages must be an image buffer'
      );
    }
    const json = await callNative(() =>
      getNative().createReaderPagesDocument(pagesId, options.documentKey)
    );
    return parseReaderDocument(json);
  }
  const textId = resolveOfflineTextBufferId(options.text);
  const imageId = bufferIdOf(options.images);
  const json = await callNative(() =>
    getNative().createReaderDocument(textId, imageId, options.documentKey)
  );
  return parseReaderDocument(json);
}

/** Options of {@link loadReaderDocument}. */
export type LoadReaderDocumentOptions = {
  /** Longest side of decoded images and pages, px (default 2048). */
  imagesMaxSide?: number;
  /** PDF page render resolution (default 144 dpi), capped by `imagesMaxSide`. */
  pdfDpi?: number;
  /** PDF password (standard encryption). */
  password?: string;
};

/**
 * Opens a book file as a reader document in one call, by its content:
 * - EPUB, FB2, MOBI / AZW3: text, structure and images.
 * - PDF: reading text from the text layer (`layout: 'paragraphs'`) and every
 *   page as a lazily rendered image; pages without text show their image.
 * - CBZ / CBR: a page document over lazily decoded pages.
 * Image buffers created here are released with the document
 * ({@link releaseReaderDocument}).
 */
export async function loadReaderDocument(
  source: FileSource,
  options?: LoadReaderDocumentOptions
): Promise<ReaderDocument> {
  const maxSide = options?.imagesMaxSide ?? 2048;
  const format = await detectDocumentFormat(source);
  if (format === 'cbz' || format === 'cbr') {
    const pages = await extractDocumentImages(source, {
      strategy: 'lazy-lru',
      maxSide,
    });
    try {
      const doc = await createReaderDocument({
        pages: pages.buffer,
        documentKey: await computeDocumentKey(source),
      });
      ownedImageBuffers.set(doc.id, pages.buffer);
      return doc;
    } catch (err: unknown) {
      await releaseOfflineImageBuffer(pages.buffer).catch(() => {});
      throw err;
    }
  }
  const text = await createEmptyOfflineTextBuffer();
  let imageBufferId: string | null = null;
  try {
    if (format === 'pdf') {
      await extractPdfTextLayer(source, text, {
        layout: 'paragraphs',
        password: options?.password,
      });
      const pages = await rasterizePdfPages(source, {
        strategy: 'lazy-lru',
        dpi: options?.pdfDpi ?? 144,
        maxSide,
        password: options?.password,
      });
      imageBufferId = pages.bufferId;
    } else {
      await extractDocumentText(source, text);
      try {
        const images = await extractDocumentImages(source, {
          scope: 'all',
          maxSide,
        });
        imageBufferId = images.buffer;
      } catch (err: unknown) {
        if (
          (err as { code?: string } | null)?.code !==
          DocumentErrorCode.NO_IMAGES
        ) {
          throw err;
        }
      }
    }
    const documentKey = await computeDocumentKey(source);
    const doc = await createReaderDocument({
      text,
      images: imageBufferId,
      documentKey,
    });
    if (imageBufferId) {
      ownedImageBuffers.set(doc.id, imageBufferId);
      imageBufferId = null;
    }
    return doc;
  } finally {
    // The reader document holds the text natively.
    await releasePipelineTextBuffer(text).catch(() => {});
    if (imageBufferId) {
      await releaseOfflineImageBuffer(imageBufferId).catch(() => {});
    }
  }
}

/**
 * Inserts an app section (text not from the file) after an existing section.
 * Resolves a new document value with a higher `revision`.
 */
export async function insertSection(
  doc: ReaderDocument,
  section: ReaderAppSection
): Promise<ReaderDocument> {
  if (!/^app:[A-Za-z0-9_-]+$/.test(section.id)) {
    throw readerError(
      ReaderErrorCode.INVALID_ARGUMENT,
      `app section id must be app:<id> ([A-Za-z0-9_-]): ${section.id}`
    );
  }
  for (const b of section.blocks) {
    if (!KEY_PATTERN.test(b.key)) {
      throw readerError(
        ReaderErrorCode.INVALID_ARGUMENT,
        `invalid block key: ${b.key}`
      );
    }
  }
  const json = await callNative(() =>
    getNative().insertReaderSection(
      doc.id,
      section.after,
      section.id,
      section.title ?? '',
      section.blocks.map((b) => b.key),
      section.blocks.map((b) => b.type),
      section.blocks.map((b) => b.text ?? ''),
      section.blocks.map((b) => b.level ?? 0)
    )
  );
  return parseReaderDocument(json);
}

/** Removes an app section. Resolves a new document value. */
export async function removeSection(
  doc: ReaderDocument,
  sectionId: string
): Promise<ReaderDocument> {
  const json = await callNative(() =>
    getNative().removeReaderSection(doc.id, sectionId)
  );
  return parseReaderDocument(json);
}

/** Blocks in reading order, paged (`count` up to the whole document). */
export async function getReaderBlocks(
  doc: ReaderDocument,
  start = 0,
  count = doc.blockCount,
  options?: { includeText?: boolean }
): Promise<ReaderBlock[]> {
  const out: ReaderBlock[] = [];
  let pos = Math.max(0, Math.trunc(start));
  const end = Math.min(doc.blockCount, pos + Math.max(0, Math.trunc(count)));
  while (pos < end) {
    const n = Math.min(MAX_BLOCKS_PER_CALL, end - pos);
    const json = await callNative(() =>
      getNative().getReaderBlocks(doc.id, pos, n, options?.includeText ?? false)
    );
    const page = JSON.parse(json) as ReaderBlock[];
    out.push(...page);
    if (page.length < n) break;
    pos += n;
  }
  return out;
}

/**
 * The book's contents in reading order: from the EPUB nav / NCX, FB2 section
 * titles or the PDF outline. Books without contents fall back to their titled
 * sections. `level` starts at 1.
 */
export async function getReaderToc(
  doc: ReaderDocument
): Promise<ReaderTocEntry[]> {
  const json = await callNative(() => getNative().getReaderToc(doc.id));
  const raw = JSON.parse(json) as Array<{
    title: string;
    level: number;
    sectionId: string;
    blockId: string;
  }>;
  return raw.map((e) => ({
    title: e.title,
    level: Math.max(1, Number(e.level) || 1),
    locator: { sectionId: e.sectionId, blockId: e.blockId },
  }));
}

/**
 * Finds a stored position again after a structure change: the block with the
 * same `textHash` nearest to `hint` (or the start). `null` if none.
 */
export async function remapLocator(
  doc: ReaderDocument,
  stored: { textHash: string; offset?: number },
  hint?: ReaderLocator | null
): Promise<ReaderLocator | null> {
  const json = await callNative(() =>
    getNative().findReaderBlockByHash(
      doc.id,
      stored.textHash,
      hint?.blockId ?? ''
    )
  );
  const found = JSON.parse(json) as {
    blockId: string;
    sectionId: string;
  } | null;
  if (!found) return null;
  return stored.offset != null
    ? {
        sectionId: found.sectionId,
        blockId: found.blockId,
        offset: stored.offset,
      }
    : { sectionId: found.sectionId, blockId: found.blockId };
}

/**
 * Maps UTF-16 ranges of the document's text buffer (e.g. sentences that were
 * read aloud) onto reader ranges, in one native call. With `slice`, the
 * ranges are in that slice's buffer instead (`createReaderTextSlice`). A range
 * start in the gap between two blocks moves to the next block, an end moves
 * back to the previous one; ranges that cover no text block resolve to `null`.
 *
 * @throws {Error} `ERR_READER_INVALID_ARGUMENT` — `slice` is not a slice of this document.
 */
export async function mapTextRanges(
  doc: ReaderDocument,
  ranges: ReadonlyArray<readonly [number, number]>,
  options?: { slice?: ReaderTextSlice | null }
): Promise<Array<ReaderRange | null>> {
  if (ranges.length === 0) return [];
  const starts = ranges.map((r) => Math.trunc(r[0]));
  const ends = ranges.map((r) => Math.trunc(r[1]));
  const sliceId = options?.slice ? String(options.slice.buffer) : '';
  const json = await callNative(() =>
    getNative().mapReaderTextRanges(doc.id, starts, ends, sliceId)
  );
  return JSON.parse(json) as Array<ReaderRange | null>;
}

/**
 * Puts the text of consecutive blocks into a new offline text buffer, to read
 * it aloud: paragraphs and headings from `from` on (file text, OCR text and
 * app sections; running headers, footers and page numbers left out), joined
 * by a blank line. It ends after the block of `to`, or before the first block
 * that would make it longer than `maxLength` UTF-16 units (the first block is
 * always included). Pass the slice to `createReadAloudTimeline` /
 * `mapTextRanges`; release `slice.buffer` when done.
 *
 * @throws {Error} `ERR_READER_INVALID_ARGUMENT` — unknown block, or no text from `from` on.
 */
export async function createReaderTextSlice(
  doc: ReaderDocument,
  options: {
    from: ReaderLocator;
    to?: ReaderLocator | null;
    maxLength?: number;
  }
): Promise<ReaderTextSlice> {
  const json = await callNative(() =>
    getNative().createReaderTextSlice(
      doc.id,
      options.from.blockId,
      Math.max(0, Math.trunc(options.from.offset ?? 0)),
      options.to?.blockId ?? '',
      Math.trunc(options.maxLength ?? 0)
    )
  );
  const raw = JSON.parse(json) as {
    bufferId: string;
    length: number;
    from: ReaderLocator;
    to: ReaderLocator;
  };
  return {
    buffer: raw.bufferId as OfflineTextBufferHandle,
    length: Number(raw.length ?? 0),
    from: raw.from,
    to: raw.to,
  };
}

/** Locator of a single text-buffer UTF-16 offset (`null` if it is in no block). */
export async function locatorAtTextOffset(
  doc: ReaderDocument,
  offset: number
): Promise<ReaderLocator | null> {
  const [range] = await mapTextRanges(doc, [[offset, offset + 1]]);
  return range ? range.from : null;
}

/** Frees the native document (and the image buffer `loadReaderDocument` made). */
export async function releaseReaderDocument(
  doc: ReaderDocument
): Promise<void> {
  await getNative().releaseReaderDocument(doc.id);
  const images = ownedImageBuffers.get(doc.id);
  if (images) {
    ownedImageBuffers.delete(doc.id);
    await releaseOfflineImageBuffer(images).catch(() => {});
  }
}

/** `s11.b42` for file blocks. */
export function formatBlockId(
  sectionIndex: number,
  blockIndex: number
): string {
  return `s${sectionIndex}.b${blockIndex}`;
}

/** Splits a block ID into section ID and key: `s11.b42` → { sectionId: 's11', key: 'b42' }. */
export function parseBlockId(blockId: string): {
  sectionId: string;
  key: string;
  sectionIndex?: number;
  blockIndex?: number;
} | null {
  const file = /^s(\d+)\.b(\d+)$/.exec(blockId);
  if (file) {
    return {
      sectionId: `s${file[1]}`,
      key: `b${file[2]}`,
      sectionIndex: Number(file[1]),
      blockIndex: Number(file[2]),
    };
  }
  const app = /^(app:[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(blockId);
  return app ? { sectionId: app[1]!, key: app[2]! } : null;
}

/**
 * Orders two locators of file blocks by position (negative: a before b).
 * Returns `null` when one of them is in an app section (order depends on the
 * document; use the block order from {@link getReaderBlocks}).
 */
export function compareLocators(
  a: ReaderLocator,
  b: ReaderLocator
): number | null {
  const pa = parseBlockId(a.blockId);
  const pb = parseBlockId(b.blockId);
  if (pa?.sectionIndex == null || pb?.sectionIndex == null) return null;
  if (pa.sectionIndex !== pb.sectionIndex)
    return pa.sectionIndex - pb.sectionIndex;
  if (pa.blockIndex !== pb.blockIndex) return pa.blockIndex! - pb.blockIndex!;
  return (a.offset ?? 0) - (b.offset ?? 0);
}
