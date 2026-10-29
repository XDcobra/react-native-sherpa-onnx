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
  | 'nemotron_parse'
  | 'paddleocr_vl';
export type OcrConcreteModelType = Exclude<OcrModelType, 'auto'>;

/** OCR backend family. Matches `OcrBackend::Family()` after a successful load. */
export type OcrFamily =
  | 'ppocr'
  | 'doctr'
  | 'doc_vlm'
  | 'nemotron_parse'
  | 'paddleocr_vl';

/** Runtime model-type array + guard (parallel TTS pattern). */
export const OCR_MODEL_TYPES: readonly OcrModelType[] = [
  'ppocr',
  'doctr',
  'doc_vlm',
  'nemotron_parse',
  'paddleocr_vl',
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

/** Known OCR recognize phases. Families may emit additional strings. */
export const OCR_PROGRESS_PHASES = [
  'preprocess',
  'patch',
  'vision',
  'embed',
  'prefill',
  'decode',
  'detect',
  'recognize',
  'parse',
] as const;

export type OcrProgressPhase =
  | (typeof OCR_PROGRESS_PHASES)[number]
  | (string & {});

/** Native→JS OCR progress coalesce. Matches download progress (200ms). */
export const OCR_PROGRESS_MIN_INTERVAL_MS = 200;

export type OcrProgress = {
  phase: OcrProgressPhase;
  done: number;
  /** 0 = indeterminate (phase label only; no percent). */
  total: number;
  frameIndex: number;
  frameCount: number;
};

/** Native `SherpaOnnxOcrProgress` event payload. */
export type OcrProgressNativeEvent = {
  operationId: string;
  done: number;
  total: number;
  phase: string;
  frameIndex?: number;
  frameCount?: number;
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
 * Shared VLM generation cap (`doc_vlm` / `nemotron_parse` / `paddleocr_vl`).
 * Omit or `0` → backend default (8192). Not valid on `ppocr` / `doctr`.
 */
export type OcrVlmOptions = {
  maxNewTokens?: number;
};

/** @deprecated Use {@link OcrVlmOptions} / top-level `maxNewTokens`. */
export type OcrDocVlmOptions = OcrVlmOptions;

/** Official PaddleOCR-VL `smart_resize` pixel bounds. */
export const PADDLEOCR_VL_MIN_PIXELS = 112896;
export const PADDLEOCR_VL_OFFICIAL_MAX_PIXELS = 1003520;
/** Phone-oriented cap (512 visual tokens). Pass via `paddleocrVl.maxPixels`. */
export const PADDLEOCR_VL_MOBILE_MAX_PIXELS = 401408;

/** Official PaddleOCR-VL control-prompt task. Omit → `'ocr'`. */
export type OcrPaddleocrVlTask = 'ocr' | 'spotting';

export type OcrPaddleocrVlOptions = {
  /**
   * `smart_resize` area cap. Omit or `0` → {@link PADDLEOCR_VL_OFFICIAL_MAX_PIXELS}.
   * Clamped to `[PADDLEOCR_VL_MIN_PIXELS, PADDLEOCR_VL_OFFICIAL_MAX_PIXELS]`.
   */
  maxPixels?: number;
  /**
   * Control-prompt task. Omit → `'ocr'`. `'spotting'` returns instance
   * text plus `<|LOC_n|>` quads on `textOut` spans. Same loaded session;
   * override per recognize via {@link OcrRecognizeOptions.paddleocrVl}.
   */
  task?: OcrPaddleocrVlTask;
};

type OcrInitShared = {
  /** ORT execution provider (`cpu`, `nnapi`, `xnnpack`, `coreml`, …). Shared by all families. */
  provider?: string;
  numThreads?: number;
};

type OcrInitFolderShared = OcrInitShared & {
  modelSource: FileSource;
  quantization?: QuantizationPreference;
};

type OcrVlmInitFields = {
  maxNewTokens?: number;
};

export type OcrInitializeOptionsAuto = OcrInitFolderShared &
  OcrVlmInitFields & {
    initMode?: 'auto';
    modelType?: 'auto';
    ppocr?: OcrPpocrOptions;
    doctr?: OcrDoctrOptions;
    paddleocrVl?: OcrPaddleocrVlOptions;
  };

export type OcrInitializeOptionsPpocr = OcrInitFolderShared & {
  initMode?: 'auto';
  modelType: 'ppocr';
  ppocr?: OcrPpocrOptions;
  doctr?: never;
  paddleocrVl?: never;
};

export type OcrInitializeOptionsDoctr = OcrInitFolderShared & {
  initMode?: 'auto';
  modelType: 'doctr';
  ppocr?: never;
  doctr?: OcrDoctrOptions;
  paddleocrVl?: never;
};

export type OcrInitializeOptionsDocVlm = OcrInitFolderShared &
  OcrVlmInitFields & {
    initMode?: 'auto';
    modelType: 'doc_vlm';
    ppocr?: never;
    doctr?: never;
    paddleocrVl?: never;
  };

export type OcrInitializeOptionsNemotronParse = OcrInitFolderShared &
  OcrVlmInitFields & {
    initMode?: 'auto';
    modelType: 'nemotron_parse';
    ppocr?: never;
    doctr?: never;
    paddleocrVl?: never;
  };

export type OcrInitializeOptionsPaddleocrVl = OcrInitFolderShared &
  OcrVlmInitFields & {
    initMode?: 'auto';
    modelType: 'paddleocr_vl';
    ppocr?: never;
    doctr?: never;
    paddleocrVl?: OcrPaddleocrVlOptions;
  };

type OcrCustomInitBase = OcrInitShared & {
  initMode: 'custom';
  customConfig: OcrCustomConfig;
};

export type OcrCustomInitializeOptions =
  | (OcrCustomInitBase & {
      modelType: 'ppocr';
      ppocr?: OcrPpocrOptions;
      doctr?: never;
      paddleocrVl?: never;
    })
  | (OcrCustomInitBase & {
      modelType: 'doctr';
      ppocr?: never;
      doctr?: OcrDoctrOptions;
      paddleocrVl?: never;
    })
  | (OcrCustomInitBase &
      OcrVlmInitFields & {
        modelType: 'doc_vlm' | 'nemotron_parse';
        ppocr?: never;
        doctr?: never;
        paddleocrVl?: never;
      })
  | (OcrCustomInitBase &
      OcrVlmInitFields & {
        modelType: 'paddleocr_vl';
        ppocr?: never;
        doctr?: never;
        paddleocrVl?: OcrPaddleocrVlOptions;
      });

export type OcrInitializeOptions =
  | OcrInitializeOptionsAuto
  | OcrInitializeOptionsPpocr
  | OcrInitializeOptionsDoctr
  | OcrInitializeOptionsDocVlm
  | OcrInitializeOptionsNemotronParse
  | OcrInitializeOptionsPaddleocrVl
  | OcrCustomInitializeOptions;

export type OcrRecognizeOptions = {
  /** Frame indices to run; default = all frames in the image buffer. */
  frames?: number[];
  /** Span level filter (default `'line'`). */
  granularity?: OcrGranularity;
  /**
   * paddleocr_vl-only recognize override. Omit → init `paddleocrVl.task`
   * (default `'ocr'`). Session stays loaded. Rejected on other families.
   */
  paddleocrVl?: {
    task?: OcrPaddleocrVlTask;
  };
  onProgress?: (progress: OcrProgress) => void;
  /**
   * Minimum ms between native progress events. Default
   * {@link OCR_PROGRESS_MIN_INTERVAL_MS} (200). `0` = unthrottled.
   * Phase / frame changes and `done === total` always emit.
   */
  progressMinIntervalMs?: number;
  /**
   * Abort at the same hooks as progress (before each Ort::Run and each
   * decode / box step). Mid-Run cancel is not supported.
   */
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
    })
  | (OcrVlmRecognizeShared & {
      family: 'paddleocr_vl';
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
