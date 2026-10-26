import type { QuantizationPreference } from '../download/types';
import type { FileSource } from '../fileio/types';
import type { OfflineImageBufferIdSource } from '../imagebuffer/types';
import type {
  OfflineTextBufferIdSource,
  TextSpatialSpanLevel,
} from '../textbuffer/types';
import type { OcrDetectModelResult } from '../types/modelDetect';
import type { OcrCustomConfig } from './customConfig';

/** Public OCR model types. `auto` resolves via layout detect. */
export type OcrModelType =
  | 'auto'
  | 'ppocr'
  | 'doctr'
  | 'doc_vlm'
  | 'nemotron_parse';
export type OcrConcreteModelType = Exclude<OcrModelType, 'auto'>;

/** OCR backend family. Matches `OcrBackend::Family()` after a successful load. */
export type OcrFamily = 'ppocr' | 'doctr' | 'doc_vlm' | 'nemotron_parse';

/** Runtime model-type array + guard (parallel TTS pattern). */
export const OCR_MODEL_TYPES: readonly OcrModelType[] = [
  'ppocr',
  'doctr',
  'doc_vlm',
  'nemotron_parse',
  'auto',
] as const;

export function isOcrModelType(s: string): s is OcrModelType {
  return (OCR_MODEL_TYPES as readonly string[]).includes(s);
}

/**
 * Span granularity requested at recognize time. Backends produce `line` spans.
 * `doc_vlm` titles and tables are `line` when locs exist; `block` is media
 * (picture/chart).
 */
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
  /**
   * Unclip ratio for DB postprocessing (default 1.5).
   * Lower values tighten detection boxes around glyphs.
   */
  detUnclipRatio?: number;
};

export type OcrDoctrOptions = {
  /** Detection box binary threshold (default 0.15). */
  detBoxThresh?: number;
  /** Detection box score threshold (default 0.15). */
  detBoxScoreThresh?: number;
  /** Unclip ratio for DB postprocessing (default 1.5). */
  detUnclipRatio?: number;
};

/**
 * Shared VLM generation cap (`doc_vlm` / `nemotron_parse`). Ignored by
 * ppocr / doctr. Omit or `0` → backend default (8192).
 */
export type OcrVlmOptions = {
  maxNewTokens?: number;
};

/** @deprecated Use {@link OcrVlmOptions} / top-level `maxNewTokens`. */
export type OcrDocVlmOptions = OcrVlmOptions;

type OcrInitShared = {
  provider?: string;
  numThreads?: number;
  maxNewTokens?: number;
};

type OcrInitFolderShared = OcrInitShared & {
  modelSource: FileSource;
  quantization?: QuantizationPreference;
};

export type OcrInitializeOptionsAuto = OcrInitFolderShared & {
  initMode?: 'auto';
  modelType?: 'auto';
  ppocr?: OcrPpocrOptions;
  doctr?: OcrDoctrOptions;
};

export type OcrInitializeOptionsPpocr = OcrInitFolderShared & {
  initMode?: 'auto';
  modelType: 'ppocr';
  ppocr?: OcrPpocrOptions;
  doctr?: never;
};

export type OcrInitializeOptionsDoctr = OcrInitFolderShared & {
  initMode?: 'auto';
  modelType: 'doctr';
  ppocr?: never;
  doctr?: OcrDoctrOptions;
};

export type OcrInitializeOptionsDocVlm = OcrInitFolderShared & {
  initMode?: 'auto';
  modelType: 'doc_vlm';
  ppocr?: never;
  doctr?: never;
};

export type OcrInitializeOptionsNemotronParse = OcrInitFolderShared & {
  initMode?: 'auto';
  modelType: 'nemotron_parse';
  ppocr?: never;
  doctr?: never;
};

export type OcrCustomInitializeOptions = OcrInitShared & {
  initMode: 'custom';
  modelType: OcrConcreteModelType;
  customConfig: OcrCustomConfig;
  /** Applied when `modelType` is `ppocr`. */
  ppocr?: OcrPpocrOptions;
  /** Applied when `modelType` is `doctr`. */
  doctr?: OcrDoctrOptions;
};

export type OcrInitializeOptions =
  | OcrInitializeOptionsAuto
  | OcrInitializeOptionsPpocr
  | OcrInitializeOptionsDoctr
  | OcrInitializeOptionsDocVlm
  | OcrInitializeOptionsNemotronParse
  | OcrCustomInitializeOptions;

export type OcrRecognizeOptions = {
  /** Frame indices to run; default = all frames in the image buffer. */
  frames?: number[];
  /** Span level filter (default `'line'`). */
  granularity?: OcrGranularity;
  onProgress?: (progress: OcrProgress) => void;
  /** Abort between frames → `OCR_CANCELLED`. */
  signal?: AbortSignal;
};

/** Why a VLM greedy decode stopped. */
export type OcrVlmStopReason =
  | 'doctag_end'
  | 'eos'
  | 'max_new_tokens'
  | 'invalid_sequence';

/** @deprecated Use {@link OcrVlmStopReason}. */
export type OcrDocVlmStopReason = OcrVlmStopReason;

type OcrVlmRecognizeShared = {
  spanCount: number;
  /** Native model stream (DocTags, or Nemotron xy/class tags plus body). */
  raw: string;
  /** GFM we produce: granite from DocTags, Nemotron from native body (`tabular` → pipe tables). */
  markdown: string;
  complete: boolean;
};

/**
 * Result of `OcrEngine.recognize`. Plain text and spans live on `textOut`.
 * Discriminated on `family`. VLM families share `raw` / `markdown` /
 * `complete` / `stopReason`. `doc_vlm` also keeps `doctags` (same as `raw`).
 */
export type OcrRecognizeResult =
  | {
      family: 'ppocr' | 'doctr';
      spanCount: number;
    }
  | (OcrVlmRecognizeShared & {
      family: 'doc_vlm';
      doctags: string;
      stopReason: OcrVlmStopReason;
    })
  | (OcrVlmRecognizeShared & {
      family: 'nemotron_parse';
      stopReason: 'eos' | 'max_new_tokens';
    });

/** @deprecated Use {@link OcrDetectModelResult} from `../types/modelDetect`. */
export type OcrDetectResult = OcrDetectModelResult;

export type OcrEngine = {
  readonly instanceId: string;
  /** OCR image → empty text buffer (text + spatial spans). */
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
