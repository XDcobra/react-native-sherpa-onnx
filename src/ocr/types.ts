import type { FileSource } from '../fileio/types';
import type {
  OfflineImageBufferIdSource,
  OfflineImageBufferRef,
} from '../imagebuffer/types';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferRef,
  TextSpatialSpanLevel,
} from '../textbuffer/types';

/** Public OCR model types. v1: ppocr only; `auto` resolves via layout detect. */
export type OcrModelType = 'auto' | 'ppocr';
export type OcrConcreteModelType = Exclude<OcrModelType, 'auto'>;

/** Span granularity requested at recognize time. v1 backends produce `line`. */
export type OcrGranularity = TextSpatialSpanLevel;

export type OcrProgress = {
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

export type OcrDetectResult = {
  ok: boolean;
  modelType: OcrConcreteModelType | string;
  family: string;
  files: {
    det: boolean;
    rec: boolean;
    cls: boolean;
    recInferenceYml: boolean;
  };
  errorCode?: string;
  errorMessage?: string;
};

export type OcrEngine = {
  readonly instanceId: string;
  /**
   * Run OCR on an offline ImageBuffer and populate an empty OfflineTextBuffer
   * (text + spatial spans with `origin: 'ocr'`).
   */
  recognize(
    imageBuffer: OfflineImageBufferIdSource | OfflineImageBufferRef | string,
    textOut: OfflineTextBufferIdSource | OfflineTextBufferRef | string,
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
