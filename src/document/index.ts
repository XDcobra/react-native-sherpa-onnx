/**
 * Offline e-document APIs — `react-native-sherpa-onnx/document`.
 *
 * - `extractDocumentText` — markup → OfflineTextBuffer (`origin: 'markup'`). Never OCR.
 * - `extractDocumentImages` — image-only sections / CBZ / CBR → OfflineImageBuffer.
 *
 * libarchive is default-on. Disable → `ERR_DOC_ARCHIVE_DISABLED`.
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
import type { OfflineTextBufferHandle } from '../textbuffer/types';
import {
  DocumentErrorCode,
  type DocumentImageFormat,
  type DocumentSectionInfo,
  type DocumentTextFormat,
  type ExtractDocumentImagesOptions,
  type ExtractDocumentImagesResult,
  type ExtractDocumentTextOptions,
  type ExtractDocumentTextResult,
  type OfflineTextBufferIdSource,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

const DOC_ERROR_CODES = new Set<string>(Object.values(DocumentErrorCode));

function nativeErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code: unknown }).code);
  }
  return '';
}

function mapDocNativeError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const code = nativeErrorCode(err);
  for (const known of DOC_ERROR_CODES) {
    if (code === known || msg.includes(known)) {
      const prefixed = msg.startsWith(known) ? msg : `${known}: ${msg}`;
      throw Object.assign(new Error(prefixed), { code: known, cause: err });
    }
  }
  throw err;
}

function assertFileSource(source: FileSource): void {
  if (
    !source ||
    typeof source !== 'object' ||
    typeof source.kind !== 'string'
  ) {
    throw Object.assign(
      new Error(
        `${DocumentErrorCode.INVALID_ARGUMENT}: source must be a FileSource`
      ),
      { code: DocumentErrorCode.INVALID_ARGUMENT }
    );
  }
}

function subscribeDocProgress(
  onProgress?: (event: { done: number; total: number; phase: string }) => void
): { remove: () => void } | null {
  if (!onProgress) {
    return null;
  }
  const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
  return emitter.addListener(
    'SherpaOnnxDocProgress',
    (ev: { done?: number; total?: number; phase?: string }) => {
      onProgress({
        done: Number(ev.done ?? 0),
        total: Number(ev.total ?? 0),
        phase: String(ev.phase ?? ''),
      });
    }
  );
}

function mapSection(raw: unknown, index: number): DocumentSectionInfo {
  const obj =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const kind = obj.kind === 'image' ? 'image' : 'text';
  const section: DocumentSectionInfo = {
    sectionIndex:
      obj.sectionIndex != null && Number.isFinite(Number(obj.sectionIndex))
        ? Math.trunc(Number(obj.sectionIndex))
        : index,
    kind,
  };
  const href = typeof obj.href === 'string' ? obj.href : '';
  if (href.length > 0) {
    section.href = href;
  }
  return section;
}

function mapSections(raw: unknown): DocumentSectionInfo[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item, i) => mapSection(item, i));
}

/**
 * Extract markup text into an empty OfflineTextBuffer (`origin: 'markup'`).
 * Never runs OCR. CBZ/CBR / scan-only documents reject with `ERR_DOC_NO_TEXT`.
 *
 * Android `app:apkAsset` is allowed: the APK zip entry is copied into app cache
 * on first open (see {@link FileSource} / `apkAsset`).
 */
export async function extractDocumentText(
  source: FileSource,
  textOut: OfflineTextBufferIdSource,
  options?: ExtractDocumentTextOptions
): Promise<ExtractDocumentTextResult> {
  assertFileSource(source);
  const textOutId = resolveOfflineTextBufferId(textOut);

  if (options?.signal?.aborted) {
    throw Object.assign(
      new Error(`${DocumentErrorCode.CANCELLED}: cancelled`),
      {
        code: DocumentErrorCode.CANCELLED,
      }
    );
  }

  const progressSub = subscribeDocProgress(options?.onProgress);

  try {
    if (__DEV__) {
      console.log('[SherpaOnnx:doc] extractDocumentText', {
        kind: source.kind,
        textOutId,
      });
    }
    const raw = await getNative().extractDocumentText(
      source as Object,
      textOutId,
      {}
    );
    const sections = mapSections(raw.sections);
    const imageOnlySections = mapSections(raw.imageOnlySections);
    return {
      buffer: textOutId as OfflineTextBufferHandle,
      format: String(raw.format ?? '') as DocumentTextFormat,
      sectionCount: Number(raw.sectionCount ?? sections.length),
      sections,
      imageOnlySections,
      spatialSpanCount: Number(raw.spatialSpanCount ?? 0),
    };
  } catch (err: unknown) {
    return mapDocNativeError(err);
  } finally {
    progressSub?.remove();
  }
}

/**
 * Extract image-only sections (or all CBZ/CBR pages) into a new OfflineImageBuffer.
 * Pure text documents reject with `ERR_DOC_NO_IMAGES`. Does not run OCR.
 *
 * Android `app:apkAsset` is allowed: the APK zip entry is copied into app cache
 * on first open (see {@link FileSource} / `apkAsset`).
 */
export async function extractDocumentImages(
  source: FileSource,
  options?: ExtractDocumentImagesOptions
): Promise<ExtractDocumentImagesResult> {
  assertFileSource(source);

  if (options?.signal?.aborted) {
    throw Object.assign(
      new Error(`${DocumentErrorCode.CANCELLED}: cancelled`),
      {
        code: DocumentErrorCode.CANCELLED,
      }
    );
  }

  const nativeOptions: { maxSide?: number } = {};
  if (options?.maxSide != null) {
    nativeOptions.maxSide = Math.trunc(options.maxSide);
  }

  const progressSub = subscribeDocProgress(options?.onProgress);

  try {
    if (__DEV__) {
      console.log('[SherpaOnnx:doc] extractDocumentImages', {
        kind: source.kind,
        maxSide: nativeOptions.maxSide,
      });
    }
    const raw = await getNative().extractDocumentImages(
      source as Object,
      nativeOptions
    );
    const bufferId = String(raw.bufferId ?? '') as OfflineImageBufferHandle;
    if (!bufferId) {
      throw Object.assign(
        new Error(
          `${DocumentErrorCode.OPEN_FAILED}: extractDocumentImages returned no bufferId`
        ),
        { code: DocumentErrorCode.OPEN_FAILED }
      );
    }
    return {
      buffer: bufferId,
      format: String(raw.format ?? '') as DocumentImageFormat,
      frameCount: Number(raw.frameCount ?? 0),
    };
  } catch (err: unknown) {
    return mapDocNativeError(err);
  } finally {
    progressSub?.remove();
  }
}

export type {
  DocumentErrorCodeValue,
  DocumentImageFormat,
  DocumentSectionInfo,
  DocumentSectionKind,
  DocumentTextFormat,
  ExtractDocumentImagesOptions,
  ExtractDocumentImagesResult,
  ExtractDocumentTextOptions,
  ExtractDocumentTextResult,
  FileSource,
  OfflineImageBufferHandle,
  OfflineTextBufferHandle,
  OfflineTextBufferIdSource,
} from './types';

export { DocumentErrorCode } from './types';
