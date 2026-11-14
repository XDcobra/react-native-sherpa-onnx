/**
 * OCR text for page images: attach a recognized text buffer to a reader
 * document, or recognize pages page by page (around the reading position or
 * the whole book). See docs/reader.md, "Text for scans and comics".
 */
import { TurboModuleRegistry } from 'react-native';

import type { Spec } from '../NativeSherpaOnnx';
import type { OcrEngine, OcrRecognizeOptions } from '../ocr/types';
import {
  createEmptyOfflineTextBuffer,
  releasePipelineTextBuffer,
  resolveOfflineTextBufferId,
} from '../textbuffer';
import type { OfflineTextBufferIdSource } from '../textbuffer/types';
import { parseReaderDocument } from './api';
import type { ReaderDocument, ReaderLocator } from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

/** A page (or image-only section) that can get OCR text. */
type ReaderPage = {
  sectionId: string;
  blockId: string;
  frame: number;
  hasText: boolean;
};

async function getPages(
  doc: ReaderDocument
): Promise<{ imageBufferId: string; pages: ReaderPage[] }> {
  const raw = JSON.parse(await getNative().getReaderPages(doc.id)) as {
    imageBufferId?: string;
    pages?: ReaderPage[];
  };
  return {
    imageBufferId: String(raw.imageBufferId ?? ''),
    pages: Array.isArray(raw.pages) ? raw.pages : [],
  };
}

/**
 * Attaches OCR text to the pages it was recognized from: `text` must be a
 * buffer filled by an OCR engine's `recognize` on this document's image
 * buffer. Each recognized page gets text blocks `s{n}.b0.t{j}` (image-only
 * sections: `{imageBlockId}.t{j}`) with headings, running headers / page
 * numbers flagged, and their places on the page; text recognized earlier for
 * the same page is replaced. Resolves the new document value (higher
 * `revision`). The document keeps the text; the caller may release its handle.
 *
 * @throws {Error} `ERR_READER_INVALID_ARGUMENT` — the buffer has no OCR layout, or was recognized on another image buffer.
 * @throws {Error} `ERR_READER_NOT_FOUND` — document or text buffer not found.
 */
export async function attachReaderPageText(
  doc: ReaderDocument,
  options: { text: OfflineTextBufferIdSource }
): Promise<ReaderDocument> {
  const textId = resolveOfflineTextBufferId(options.text);
  return parseReaderDocument(
    await getNative().attachReaderPageText(doc.id, textId)
  );
}

/** Options of {@link recognizeReaderPages}. */
export type RecognizeReaderPagesOptions = {
  /**
   * - `'around'` (default): the page at `at`, the next `ahead` pages and the
   *   previous `behind` pages.
   * - `'all'`: every page, from the first (a full run).
   * - `{ sections }`: these page sections.
   * Pages that already have text are skipped unless `force` is set.
   */
  scope?: 'around' | 'all' | { sections: string[] };
  /** Reading position for `'around'` (default: the first page). */
  at?: ReaderLocator | null;
  /** `'around'`: pages after `at` (default 2). */
  ahead?: number;
  /** `'around'`: pages before `at` (default 1). */
  behind?: number;
  /** Recognize pages that already have text again (default false). */
  force?: boolean;
  /**
   * Passed to every `recognize` call (`readingDirection`, `instruction`,
   * `granularity`, …). `frames`, `signal` and `onProgress` are set here.
   */
  recognize?: Omit<OcrRecognizeOptions, 'frames' | 'signal' | 'onProgress'>;
  /**
   * The document after newly recognized pages; pass it to `<ReaderView>`.
   * Called at most every `updateIntervalMs` while running and once at the end.
   */
  onDocument?: (doc: ReaderDocument) => void;
  /** Minimum ms between `onDocument` calls while running (default 300). */
  updateIntervalMs?: number;
  /** After each page: pages done / to do, and the page's section. */
  onProgress?: (event: {
    done: number;
    total: number;
    sectionId: string;
  }) => void;
  /** Stops after the page in progress; recognized pages stay attached. */
  signal?: AbortSignal;
};

function pickPages(
  pages: ReaderPage[],
  options: RecognizeReaderPagesOptions
): ReaderPage[] {
  const scope = options.scope ?? 'around';
  let picked: ReaderPage[];
  if (scope === 'all') {
    picked = pages;
  } else if (typeof scope === 'object') {
    const wanted = new Set(scope.sections);
    picked = pages.filter((p) => wanted.has(p.sectionId));
  } else {
    const at = options.at;
    let i = at ? pages.findIndex((p) => p.sectionId === at.sectionId) : 0;
    if (i < 0) i = 0;
    const ahead = Math.max(0, Math.trunc(options.ahead ?? 2));
    const behind = Math.max(0, Math.trunc(options.behind ?? 1));
    // The current page first, then the ones ahead, then the ones behind (nearest first).
    picked = pages.slice(i, i + 1 + ahead);
    for (let k = 1; k <= behind && i - k >= 0; ++k) {
      const page = pages[i - k];
      if (page) picked.push(page);
    }
  }
  return options.force ? picked : picked.filter((p) => !p.hasText);
}

/**
 * Recognizes page images of a reader document with an OCR engine, one page
 * per `recognize` call, and attaches the text to each page as it is done
 * ({@link attachReaderPageText}). Use `'around'` while reading (text grows
 * where the reader is) or `'all'` for the whole book. Resolves the last
 * document value; when aborted, the pages done so far keep their text.
 * Run one at a time per document.
 *
 * @throws {Error} errors of `recognize` (for example `OCR_RECOGNIZE_FAILED`) and of {@link attachReaderPageText}.
 */
export async function recognizeReaderPages(
  doc: ReaderDocument,
  ocr: OcrEngine,
  options: RecognizeReaderPagesOptions = {}
): Promise<ReaderDocument> {
  const { imageBufferId, pages } = await getPages(doc);
  const todo = imageBufferId ? pickPages(pages, options) : [];
  const interval = Math.max(0, options.updateIntervalMs ?? 300);
  const recognize = ocr.recognize as (
    image: string,
    text: OfflineTextBufferIdSource,
    opts?: OcrRecognizeOptions
  ) => Promise<unknown>;
  let current = doc;
  let lastEmit = 0;
  let pending = false;
  let done = 0;
  for (const page of todo) {
    if (options.signal?.aborted) break;
    const text = await createEmptyOfflineTextBuffer();
    try {
      await recognize.call(ocr, imageBufferId, text, {
        ...options.recognize,
        frames: [page.frame],
        signal: options.signal,
      });
      current = await attachReaderPageText(current, { text });
    } catch (err: unknown) {
      if (options.signal?.aborted) break;
      throw err;
    } finally {
      // The document holds the recognized text natively.
      await releasePipelineTextBuffer(text).catch(() => {});
    }
    done += 1;
    options.onProgress?.({
      done,
      total: todo.length,
      sectionId: page.sectionId,
    });
    pending = true;
    const now = Date.now();
    if (now - lastEmit >= interval) {
      lastEmit = now;
      pending = false;
      options.onDocument?.(current);
    }
  }
  if (pending) options.onDocument?.(current);
  return current;
}
