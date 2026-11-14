/**
 * Reader documents: native `rdr_*` handles built from a text buffer's reading
 * structure (EPUB via `extractDocumentText`). See docs/reader.md.
 */
import { TurboModuleRegistry } from 'react-native';

import type { Spec } from '../NativeSherpaOnnx';
import {
  extractDocumentImages,
  extractDocumentText,
  DocumentErrorCode,
} from '../document';
import type { FileSource } from '../fileio/types';
import { releaseOfflineImageBuffer } from '../imagebuffer';
import {
  createEmptyOfflineTextBuffer,
  releasePipelineTextBuffer,
  resolveOfflineTextBufferId,
} from '../textbuffer';
import type { OfflineTextBufferIdSource } from '../textbuffer/types';
import type {
  ReaderAppSection,
  ReaderBlock,
  ReaderDocument,
  ReaderLocator,
  ReaderRange,
  ReaderSectionInfo,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

export const ReaderErrorCode = {
  NOT_FOUND: 'ERR_READER_NOT_FOUND',
  NO_STRUCTURE: 'ERR_READER_NO_STRUCTURE',
  UNSUPPORTED_STRUCTURE: 'ERR_READER_UNSUPPORTED_STRUCTURE',
  INVALID_ARGUMENT: 'ERR_READER_INVALID_ARGUMENT',
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

async function callNative<T>(fn: () => Promise<T>): Promise<T> {
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
export function parseReaderDocument(json: string): ReaderDocument {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).map(
    (item): ReaderSectionInfo => {
      const s = item as Record<string, unknown>;
      const titleSource = s.titleSource;
      const out: ReaderSectionInfo = {
        id: String(s.id ?? ''),
        origin: s.origin === 'app' ? 'app' : 'file',
        kind: s.kind === 'image' ? 'image' : 'text',
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

/**
 * Reader document from a text buffer filled by `extractDocumentText` (EPUB)
 * and, optionally, the image buffer from
 * `extractDocumentImages(source, { scope: 'all' })` for image blocks.
 * The document keeps the text alive; the caller may release its text handle.
 */
export async function createReaderDocument(options: {
  text: OfflineTextBufferIdSource;
  images?: string | { bufferId: string } | null;
  documentKey: string;
}): Promise<ReaderDocument> {
  const textId = resolveOfflineTextBufferId(options.text);
  const imageId =
    options.images == null
      ? ''
      : typeof options.images === 'string'
      ? options.images
      : options.images.bufferId;
  const json = await callNative(() =>
    getNative().createReaderDocument(textId, imageId, options.documentKey)
  );
  return parseReaderDocument(json);
}

/**
 * Extract an EPUB, its images (`scope: 'all'`) and its key, and build a reader
 * document in one call. Release it with {@link releaseReaderDocument}.
 */
export async function loadReaderDocument(
  source: FileSource,
  options?: { imagesMaxSide?: number }
): Promise<ReaderDocument> {
  const text = await createEmptyOfflineTextBuffer();
  let imageBufferId: string | null = null;
  try {
    await extractDocumentText(source, text);
    try {
      const images = await extractDocumentImages(source, {
        scope: 'all',
        maxSide: options?.imagesMaxSide ?? 2048,
      });
      imageBufferId = images.buffer;
    } catch (err: unknown) {
      if (
        (err as { code?: string } | null)?.code !== DocumentErrorCode.NO_IMAGES
      ) {
        throw err;
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
 * read aloud) onto reader ranges, in one native call. A range start in the gap
 * between two blocks moves to the next block, an end moves back to the
 * previous one; ranges that cover no file text block resolve to `null`.
 */
export async function mapTextRanges(
  doc: ReaderDocument,
  ranges: ReadonlyArray<readonly [number, number]>
): Promise<Array<ReaderRange | null>> {
  if (ranges.length === 0) return [];
  const starts = ranges.map((r) => Math.trunc(r[0]));
  const ends = ranges.map((r) => Math.trunc(r[1]));
  const json = await callNative(() =>
    getNative().mapReaderTextRanges(doc.id, starts, ends)
  );
  return JSON.parse(json) as Array<ReaderRange | null>;
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
