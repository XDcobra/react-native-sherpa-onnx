import type { FileSource } from '../fileio/types';
import type { OfflineImageBufferIdSource } from '../imagebuffer/types';
import type {
  OfflineTextBufferIdSource,
  TextSpatialSpanLevel,
} from '../textbuffer/types';
import type {
  OcrDetectModelResult,
  OcrPpocrSuccessPaths,
} from '../types/modelDetect';

/** Public OCR model types. v1: ppocr only; `auto` resolves via layout detect. */
export type OcrModelType = 'auto' | 'ppocr';
export type OcrConcreteModelType = Exclude<OcrModelType, 'auto'>;

/** OCR backend family (v1: ppocr only). */
export type OcrFamily = 'ppocr';

/** Span granularity requested at recognize time. v1 backends produce `line`. */
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

export type OcrInitializeOptions = {
  modelSource: FileSource;
  /** Default: `'auto'`. */
  modelType?: OcrModelType;
  provider?: string;
  numThreads?: number;
  /** Family-specific options (only `ppocr` applies in v1). */
  ppocr?: OcrPpocrOptions;
};

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

/** @deprecated Use {@link OcrDetectModelResult} from `../types/modelDetect`. */
export type OcrDetectResult = OcrDetectModelResult;

export type OcrEngine = {
  readonly instanceId: string;
  /**
   * Run OCR on an offline ImageBuffer and populate an empty OfflineTextBuffer
   * (text + spatial spans with `origin: 'ocr'`).
   */
  recognize(
    imageBuffer: OfflineImageBufferIdSource,
    textOut: OfflineTextBufferIdSource,
    options?: OcrRecognizeOptions
  ): Promise<void>;
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
