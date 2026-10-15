import type { FileSource } from '../fileio/types';
import type { OfflineImageBufferIdSource } from '../imagebuffer/types';
import type {
  OfflineTextBufferIdSource,
  TextSpatialSpanLevel,
} from '../textbuffer/types';
import type {
  OcrDetectModelResult,
  OcrDocVlmSuccessPaths,
  OcrDoctrSuccessPaths,
  OcrPpocrSuccessPaths,
} from '../types/modelDetect';

/** Public OCR model types. `auto` resolves via layout detect. */
export type OcrModelType = 'auto' | 'ppocr' | 'doctr' | 'doc_vlm';
export type OcrConcreteModelType = Exclude<OcrModelType, 'auto'>;

/** OCR backend family. Matches `OcrBackend::Family()` after a successful load. */
export type OcrFamily = 'ppocr' | 'doctr' | 'doc_vlm';

/** Runtime model-type array + guard (parallel TTS pattern). */
export const OCR_MODEL_TYPES: readonly OcrModelType[] = [
  'ppocr',
  'doctr',
  'doc_vlm',
  'auto',
] as const;

export function isOcrModelType(s: string): s is OcrModelType {
  return (OCR_MODEL_TYPES as readonly string[]).includes(s);
}

/** Span granularity requested at recognize time. Backends produce `line` spans. */
export type OcrGranularity = TextSpatialSpanLevel;

export type OcrProgress = {
  done: number;
  total: number;
  phase: string;
};

/** Native `SherpaOnnxOcrProgress` event payload. */
export type OcrProgressNativeEvent = {
  operationId: string;
  done: number;
  total: number;
  phase: string;
};

export type OcrPpocrOptions = {
  maxSideLen?: number;
  useOrientationCls?: boolean;
};

export type OcrDoctrOptions = {
  /**
   * Detection box binary-threshold (doctr default: 0.15).
   * DoctrBackend auto-lowers ppocr-range values; set explicitly to override.
   */
  detBoxThresh?: number;
  /**
   * Detection box score threshold (doctr default: 0.15).
   */
  detBoxScoreThresh?: number;
  /**
   * Unclip ratio for DB postprocessing (default: 1.5).
   */
  detUnclipRatio?: number;
};

/**
 * doc_vlm generation options. Applied only when the loaded family is `doc_vlm`
 * (`modelType: 'doc_vlm'`, or `auto` once Phase 4 detect can resolve this pack).
 * Ignored by ppocr and doctr. Decode is greedy; this object does not grow
 * sampling fields in v1.
 */
export type OcrDocVlmOptions = {
  /**
   * Cap on newly generated token ids.
   * Omit or `0` → 8192 (Docling granite preset, also `text.max_position_embeddings`).
   * The backend lowers the cap when `prompt_length + maxNewTokens` would pass 8192
   * and logs the clamp under `[SherpaOnnx:ocr]`.
   * A positive value is forwarded as-is. Non-integers and negatives are
   * `OCR_INVALID_ARGUMENT` at `createOCR`, before native load.
   */
  maxNewTokens?: number;
};

type OcrInitShared = {
  modelSource: FileSource;
  provider?: string;
  numThreads?: number;
};

export type OcrInitializeOptionsAuto = OcrInitShared & {
  modelType?: 'auto';
  ppocr?: OcrPpocrOptions;
  doctr?: OcrDoctrOptions;
  docVlm?: OcrDocVlmOptions;
};

export type OcrInitializeOptionsPpocr = OcrInitShared & {
  modelType: 'ppocr';
  ppocr?: OcrPpocrOptions;
  doctr?: never;
  docVlm?: never;
};

export type OcrInitializeOptionsDoctr = OcrInitShared & {
  modelType: 'doctr';
  ppocr?: never;
  doctr?: OcrDoctrOptions;
  docVlm?: never;
};

export type OcrInitializeOptionsDocVlm = OcrInitShared & {
  modelType: 'doc_vlm';
  ppocr?: never;
  doctr?: never;
  docVlm?: OcrDocVlmOptions;
};

export type OcrInitializeOptions =
  | OcrInitializeOptionsAuto
  | OcrInitializeOptionsPpocr
  | OcrInitializeOptionsDoctr
  | OcrInitializeOptionsDocVlm;

export type OcrRecognizeOptions = {
  /** Frame indices to run; default = all frames in the image buffer. */
  frames?: number[];
  /**
   * Requested span level. v1 PpocrBackend emits `line` only;
   * other values filter spans (may yield an empty span list).
   */
  granularity?: OcrGranularity;
  onProgress?: (progress: OcrProgress) => void;
  signal?: AbortSignal;
};

/**
 * Resolved value of `OcrEngine.recognize`.
 * Plain text and spatial spans are on `textOut` (`origin: 'ocr'`).
 * This object is the structured extras channel plus a family tag.
 * Failures still reject (`OCR_CANCELLED`, `OCR_RECOGNIZE_FAILED`, …);
 * they do not come back as `status: 'failed'`.
 */
export type OcrRecognizeResult = {
  /**
   * `OcrBackend::Family()` of the loaded engine.
   * `createOCR({ modelType: 'auto' })` still echoes `'auto'` from `initializeOcr`.
   * This field is the concrete family.
   */
  family: OcrFamily;
  /** Spans written to `textOut` after the granularity filter. */
  spanCount: number;
  /**
   * Raw DocTags after ASCII lstrip. `""` for ppocr and doctr.
   * doc_vlm: the decoded generation, specials kept (`<doctag>` … `</doctag>`).
   */
  doctags: string;
  /**
   * Lossy markdown from the same DocTags walk. `""` for ppocr and doctr.
   * doc_vlm: empty only when the plain text is empty (Phase 2 §7.2).
   */
  markdown: string;
};

/** @deprecated Use {@link OcrDetectModelResult} from `../types/modelDetect`. */
export type OcrDetectResult = OcrDetectModelResult;

export type OcrEngine = {
  readonly instanceId: string;
  /**
   * Run OCR on an offline ImageBuffer and populate an empty OfflineTextBuffer
   * (text + spatial spans with `origin: 'ocr'`).
   * DocTags and markdown are on the returned result, not the text buffer.
   */
  recognize(
    imageBuffer: OfflineImageBufferIdSource,
    textOut: OfflineTextBufferIdSource,
    options?: OcrRecognizeOptions
  ): Promise<OcrRecognizeResult>;
  destroy(): Promise<void>;
};

export const OcrErrorCode = {
  INSTANCE_NOT_FOUND: 'OCR_INSTANCE_NOT_FOUND',
  NOT_INITIALIZED: 'OCR_NOT_INITIALIZED',
  INVALID_ARGUMENT: 'OCR_INVALID_ARGUMENT',
  MODEL_NOT_FOUND: 'OCR_MODEL_NOT_FOUND',
  DETECT_FAILED: 'OCR_DETECT_FAILED',
  IMAGE_BUFFER_NOT_FOUND: 'OCR_IMAGE_BUFFER_NOT_FOUND',
  IMAGE_BUFFER_EMPTY: 'OCR_IMAGE_BUFFER_EMPTY',
  FRAME_READ_FAILED: 'OCR_FRAME_READ_FAILED',
  RECOGNIZE_FAILED: 'OCR_RECOGNIZE_FAILED',
  CANCELLED: 'OCR_CANCELLED',
  ALREADY_POPULATED: 'OCR_ALREADY_POPULATED',
  INTERNAL_ERROR: 'OCR_INTERNAL_ERROR',
  BUSY: 'OCR_BUSY',
} as const;

export type OcrErrorCodeValue =
  (typeof OcrErrorCode)[keyof typeof OcrErrorCode];

/**
 * Narrows a successful doctr detect result to required Det/Rec/manifest paths.
 * Use after {@link detectOcrModel} when callers need typed pack paths.
 */
export function isOcrDoctrDetectSuccess(
  result: OcrDetectModelResult
): result is OcrDetectModelResult & {
  success: true;
  modelType: 'doctr';
  paths: OcrDoctrSuccessPaths;
} {
  if (!result.success || result.modelType !== 'doctr' || result.paths == null) {
    return false;
  }
  const { det, rec, manifest } = result.paths;
  return (
    typeof det === 'string' &&
    det.length > 0 &&
    typeof rec === 'string' &&
    rec.length > 0 &&
    typeof manifest === 'string' &&
    manifest.length > 0
  );
}

/**
 * Narrows a successful ppocr detect result to required Det/Rec/dict paths.
 * Use after {@link detectOcrModel} when callers need typed pack paths.
 */
export function isOcrPpocrDetectSuccess(
  result: OcrDetectModelResult
): result is OcrDetectModelResult & {
  success: true;
  modelType: 'ppocr';
  paths: OcrPpocrSuccessPaths;
} {
  if (!result.success || result.modelType !== 'ppocr' || result.paths == null) {
    return false;
  }
  const { det, rec, rec_dict: recDict } = result.paths;
  return (
    typeof det === 'string' &&
    det.length > 0 &&
    typeof rec === 'string' &&
    rec.length > 0 &&
    typeof recDict === 'string' &&
    recDict.length > 0
  );
}

const DOC_VLM_PATH_KEYS = [
  'vision_encoder',
  'vision_encoder_data',
  'embed_tokens',
  'embed_tokens_data',
  'decoder',
  'decoder_data',
  'tokenizer',
  'manifest',
] as const;

export function isOcrDocVlmDetectSuccess(
  result: OcrDetectModelResult
): result is OcrDetectModelResult & {
  success: true;
  modelType: 'doc_vlm';
  paths: OcrDocVlmSuccessPaths;
} {
  if (
    !result.success ||
    result.modelType !== 'doc_vlm' ||
    result.paths == null
  ) {
    return false;
  }
  const paths = result.paths;
  return DOC_VLM_PATH_KEYS.every((key) => {
    const value = paths[key];
    return typeof value === 'string' && value.length > 0;
  });
}
