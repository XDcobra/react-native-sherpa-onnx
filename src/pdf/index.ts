/**
 * Offline PDF APIs — `react-native-sherpa-onnx/pdf`.
 *
 * Opt-in native dependency: rebuild with `sherpaOnnxEnablePdfium=true` (Android)
 * or `SHERPA_ONNX_ENABLE_PDFIUM=1` (iOS). Default builds reject with
 * `ERR_PDF_PDFIUM_DISABLED`.
 *
 * - `extractPdfTextLayer` — digital text layer only (no OCR/raster fallback).
 * - `rasterizePdfPages` — page bitmaps → OfflineImageBuffer (explicit OCR later).
 */

import {
  NativeEventEmitter,
  NativeModules,
  TurboModuleRegistry,
} from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';
import type { OfflineImageBufferHandle } from '../imagebuffer/types';
import { resolveOfflineTextBufferId } from '../textbuffer';
import {
  PdfErrorCode,
  type ExtractPdfTextLayerOptions,
  type ExtractPdfTextLayerResult,
  type OfflineTextBufferIdSource,
  type RasterizePdfPagesOptions,
  type RasterizePdfPagesResult,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

function nativeErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code: unknown }).code);
  }
  return '';
}

function mapPdfNativeError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const code = nativeErrorCode(err);
  if (
    code === PdfErrorCode.PDFIUM_DISABLED ||
    msg.includes(PdfErrorCode.PDFIUM_DISABLED) ||
    msg.includes('PDFium is not linked')
  ) {
    throw Object.assign(
      new Error(
        `${PdfErrorCode.PDFIUM_DISABLED}: PDFium is not linked. Rebuild with sherpaOnnxEnablePdfium=true (Android) or SHERPA_ONNX_ENABLE_PDFIUM=1 (iOS) and ensure pdfium prebuilts resolve.`
      ),
      { code: PdfErrorCode.PDFIUM_DISABLED, cause: err }
    );
  }
  // RN promise.reject(code, message) puts the code on error.code; message is
  // often the human sentence without ERR_PDF_NO_TEXT_LAYER.
  if (
    code === PdfErrorCode.NO_TEXT_LAYER ||
    msg.includes(PdfErrorCode.NO_TEXT_LAYER) ||
    /no extractable text layer/i.test(msg)
  ) {
    throw Object.assign(
      new Error(
        `${PdfErrorCode.NO_TEXT_LAYER}: No extractable text layer on the selected pages (scan-only PDF or empty)`
      ),
      { code: PdfErrorCode.NO_TEXT_LAYER, cause: err }
    );
  }
  throw err;
}

function assertFileSource(source: FileSource): void {
  if (
    !source ||
    typeof source !== 'object' ||
    typeof source.kind !== 'string'
  ) {
    throw new Error(
      `${PdfErrorCode.INVALID_ARGUMENT}: source must be a FileSource`
    );
  }
}

function buildPagesOption(
  pages: ExtractPdfTextLayerOptions['pages'] | RasterizePdfPagesOptions['pages']
): number[] | undefined {
  if (pages == null || pages === 'all') {
    return undefined;
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error(
      `${PdfErrorCode.INVALID_ARGUMENT}: pages must be 'all' or a non-empty number[]`
    );
  }
  return pages.map((p) => Math.trunc(p));
}

function subscribePdfProgress(
  onProgress?: (event: { done: number; total: number; phase: string }) => void
): { remove: () => void } | null {
  if (!onProgress) {
    return null;
  }
  const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
  return emitter.addListener(
    'SherpaOnnxPdfProgress',
    (ev: { done?: number; total?: number; phase?: string }) => {
      onProgress({
        done: Number(ev.done ?? 0),
        total: Number(ev.total ?? 0),
        phase: String(ev.phase ?? ''),
      });
    }
  );
}

/** Whether this binary was built with PDFium linked. */
export async function isPdfiumEnabled(): Promise<boolean> {
  try {
    return Boolean(await getNative().isPdfiumEnabled());
  } catch {
    return false;
  }
}

/**
 * Extract PDF text layer into an empty OfflineTextBuffer.
 * Spans use `origin: 'textLayer'` with pageNumber / pageWidth / pageHeight.
 */
export async function extractPdfTextLayer(
  source: FileSource,
  textOut: OfflineTextBufferIdSource,
  options?: ExtractPdfTextLayerOptions
): Promise<ExtractPdfTextLayerResult> {
  assertFileSource(source);
  const textOutId = resolveOfflineTextBufferId(textOut);

  if (options?.signal?.aborted) {
    throw Object.assign(new Error(`${PdfErrorCode.CANCELLED}: cancelled`), {
      code: PdfErrorCode.CANCELLED,
    });
  }

  const nativeOptions: { pages?: number[] } = {};
  const pages = buildPagesOption(options?.pages);
  if (pages) {
    nativeOptions.pages = pages;
  }

  const progressSub = subscribePdfProgress(options?.onProgress);

  try {
    if (__DEV__) {
      console.log('[SherpaOnnx:pdf] extractPdfTextLayer', {
        kind: source.kind,
        textOutId,
        pages: nativeOptions.pages ?? 'all',
      });
    }
    const raw = await getNative().extractPdfTextLayer(
      source as Object,
      textOutId,
      nativeOptions
    );
    return {
      pageCount: Number(raw.pageCount ?? 0),
      pagesWithText: Number(raw.pagesWithText ?? 0),
      utf16Length: Number(raw.utf16Length ?? 0),
      spatialSpanCount: Number(raw.spatialSpanCount ?? 0),
    };
  } catch (err: unknown) {
    return mapPdfNativeError(err);
  } finally {
    progressSub?.remove();
  }
}

/**
 * Rasterize PDF pages into a new OfflineImageBuffer (RGB8).
 * Each frame exposes optional `pageNumber` / `dpi` via getOfflineImageBufferFrameInfo.
 * Does not run OCR — call createOCR().recognize explicitly afterward.
 */
export async function rasterizePdfPages(
  source: FileSource,
  options?: RasterizePdfPagesOptions
): Promise<RasterizePdfPagesResult> {
  assertFileSource(source);

  if (options?.signal?.aborted) {
    throw Object.assign(new Error(`${PdfErrorCode.CANCELLED}: cancelled`), {
      code: PdfErrorCode.CANCELLED,
    });
  }

  const strategy = options?.strategy ?? 'rasterize-all';
  if (strategy !== 'rasterize-all' && strategy !== 'lazy-lru') {
    throw new Error(
      `${PdfErrorCode.INVALID_ARGUMENT}: strategy must be 'rasterize-all' or 'lazy-lru'`
    );
  }

  const nativeOptions: {
    pages?: number[];
    dpi?: number;
    maxSide?: number;
    strategy?: string;
    hotFrames?: number;
  } = { strategy };
  const pages = buildPagesOption(options?.pages);
  if (pages) {
    nativeOptions.pages = pages;
  }
  if (options?.dpi != null) {
    const dpi = Math.trunc(options.dpi);
    if (!(dpi > 0)) {
      throw new Error(`${PdfErrorCode.INVALID_ARGUMENT}: dpi must be > 0`);
    }
    nativeOptions.dpi = dpi;
  }
  if (options?.maxSide != null) {
    nativeOptions.maxSide = Math.trunc(options.maxSide);
  }
  if (strategy === 'lazy-lru' && options?.hotFrames != null) {
    nativeOptions.hotFrames = Math.trunc(options.hotFrames);
  }

  const progressSub = subscribePdfProgress(options?.onProgress);

  try {
    if (__DEV__) {
      console.log('[SherpaOnnx:pdf] rasterizePdfPages', {
        kind: source.kind,
        pages: nativeOptions.pages ?? 'all',
        dpi: nativeOptions.dpi ?? 144,
        maxSide: nativeOptions.maxSide ?? 4096,
        strategy,
        hotFrames: nativeOptions.hotFrames,
      });
    }
    const raw = await getNative().rasterizePdfPages(
      source as Object,
      nativeOptions
    );
    const bufferId = String(raw.bufferId ?? '') as OfflineImageBufferHandle;
    if (!bufferId) {
      throw new Error(
        `${PdfErrorCode.INTERNAL}: rasterizePdfPages returned no bufferId`
      );
    }
    return {
      bufferId,
      info: {
        bufferId,
        kind: 'offlineImageBuffer',
        state: raw.state === 'lazy' ? 'lazy' : 'immutable',
        frameCount: Number(raw.frameCount ?? 0),
        totalBytes: Number(raw.totalBytes ?? 0),
        storageKind: raw.storageKind === 'mmap' ? 'mmap' : 'ram',
      },
      pageCount: Number(raw.pageCount ?? 0),
    };
  } catch (err: unknown) {
    return mapPdfNativeError(err);
  } finally {
    progressSub?.remove();
  }
}

export type {
  ExtractPdfTextLayerOptions,
  ExtractPdfTextLayerResult,
  FileSource,
  OfflineImageBufferRef,
  OfflineTextBufferIdSource,
  PdfErrorCodeValue,
  RasterizePdfPagesOptions,
  RasterizePdfPagesResult,
  RasterizePdfStrategy,
} from './types';

export { PdfErrorCode } from './types';
