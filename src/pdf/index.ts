/**
 * Offline PDF text-layer extract — `react-native-sherpa-onnx/pdf`.
 *
 * Opt-in native dependency: rebuild with `sherpaOnnxEnablePdfium=true` (Android)
 * or `SHERPA_ONNX_ENABLE_PDFIUM=1` (iOS). Default builds reject with
 * `ERR_PDF_PDFIUM_DISABLED`.
 *
 * Digital PDFs only (native text layer). Scan-only PDFs reject with
 * `ERR_PDF_NO_TEXT_LAYER` — no OCR/raster fallback.
 */

import {
  NativeEventEmitter,
  NativeModules,
  TurboModuleRegistry,
} from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';
import { resolveOfflineTextBufferId } from '../textbuffer';
import {
  PdfErrorCode,
  type ExtractPdfTextLayerOptions,
  type ExtractPdfTextLayerResult,
  type OfflineTextBufferIdSource,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

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
  if (
    !source ||
    typeof source !== 'object' ||
    typeof source.kind !== 'string'
  ) {
    throw new Error(
      `${PdfErrorCode.INVALID_ARGUMENT}: source must be a FileSource`
    );
  }
  const textOutId = resolveOfflineTextBufferId(textOut);

  if (options?.signal?.aborted) {
    throw Object.assign(new Error(`${PdfErrorCode.CANCELLED}: cancelled`), {
      code: PdfErrorCode.CANCELLED,
    });
  }

  const nativeOptions: { pages?: number[] } = {};
  if (options?.pages != null && options.pages !== 'all') {
    if (!Array.isArray(options.pages) || options.pages.length === 0) {
      throw new Error(
        `${PdfErrorCode.INVALID_ARGUMENT}: pages must be 'all' or a non-empty number[]`
      );
    }
    nativeOptions.pages = options.pages.map((p) => Math.trunc(p));
  }

  let progressSub: { remove: () => void } | null = null;
  if (options?.onProgress) {
    const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
    const onProgress = options.onProgress;
    progressSub = emitter.addListener(
      'SherpaOnnxPdfProgress',
      (ev: { done?: number; total?: number; phase?: string }) => {
        onProgress({
          done: Number(ev.done ?? 0),
          total: Number(ev.total ?? 0),
          phase: String(ev.phase ?? 'extract'),
        });
      }
    );
  }

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
    const msg = err instanceof Error ? err.message : String(err);
    if (
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
    throw err;
  } finally {
    progressSub?.remove();
  }
}

export type {
  ExtractPdfTextLayerOptions,
  ExtractPdfTextLayerResult,
  FileSource,
  OfflineTextBufferIdSource,
  PdfErrorCodeValue,
} from './types';

export { PdfErrorCode } from './types';
