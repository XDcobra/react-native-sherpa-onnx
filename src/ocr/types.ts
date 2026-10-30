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

/** Axis-aligned rectangle in decoded-frame pixels (same space as span quads). */
export interface OcrPixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OcrInstructionFamily =
  | 'doc_vlm'
  | 'nemotron_parse'
  | 'paddleocr_vl';

/** Phase 0 lock: Granite `element/chart` emits `<unknown>` on 3/3 HF fixtures. */
export type OcrDocVlmElement = 'table' | 'formula' | 'code';
export type OcrDocVlmInstruction =
  | { task: 'page' }
  | { task: 'element'; element: OcrDocVlmElement }
  | { task: 'regionText'; region: OcrPixelRect }
  | { task: 'identifyElement'; region: OcrPixelRect };

/** Phase 0 lock: only `markdown_none_pic` is in the public union. */
export type OcrNemotronParseLayout = 'none';
export type OcrNemotronParseOutput = {
  text: 'markdown';
  layout: 'none';
  textInPictures: true;
};
export type OcrNemotronParseInstruction = {
  task: 'page';
  output: OcrNemotronParseOutput;
};

export type OcrPaddleocrVlInstruction = { task: OcrPaddleocrVlTask };

export type OcrInstructionOf<F extends OcrInstructionFamily> = {
  doc_vlm: OcrDocVlmInstruction;
  nemotron_parse: OcrNemotronParseInstruction;
  paddleocr_vl: OcrPaddleocrVlInstruction;
}[F];

export type OcrTaskOf<F extends OcrInstructionFamily> =
  OcrInstructionOf<F>['task'];

export const OCR_DEFAULT_INSTRUCTIONS: {
  [F in OcrInstructionFamily]: OcrInstructionOf<F>;
} = {
  doc_vlm: { task: 'page' },
  nemotron_parse: {
    task: 'page',
    output: { text: 'markdown', layout: 'none', textInPictures: true },
  },
  paddleocr_vl: { task: 'ocr' },
};

export interface OcrCapabilitiesOf<F extends OcrFamily> {
  family: F;
  tasks: F extends OcrInstructionFamily ? readonly OcrTaskOf<F>[] : readonly [];
  granularities: readonly OcrGranularity[];
  supportsCrop: true;
  producesElements: boolean;
}

/** Phase 1 native table. createOCR checks native reports a subset of these. */
export const OCR_CAPABILITIES = {
  ppocr: {
    family: 'ppocr',
    tasks: [] as const,
    granularities: ['line'] as const,
    supportsCrop: true,
    producesElements: false,
  },
  doctr: {
    family: 'doctr',
    tasks: [] as const,
    granularities: ['line'] as const,
    supportsCrop: true,
    producesElements: false,
  },
  doc_vlm: {
    family: 'doc_vlm',
    tasks: ['page', 'element', 'regionText', 'identifyElement'] as const,
    granularities: ['line', 'block'] as const,
    supportsCrop: true,
    producesElements: true,
  },
  nemotron_parse: {
    family: 'nemotron_parse',
    tasks: ['page'] as const,
    granularities: ['line'] as const,
    supportsCrop: true,
    producesElements: true,
  },
  paddleocr_vl: {
    family: 'paddleocr_vl',
    tasks: ['ocr', 'table', 'formula', 'chart', 'seal', 'spotting'] as const,
    granularities: ['line'] as const,
    supportsCrop: true,
    producesElements: false,
  },
} as const satisfies { [F in OcrFamily]: OcrCapabilitiesOf<F> };

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

/** Shared by ppocr and doctr (both DB detectors). */
export interface OcrDbDetectorOptions {
  detBoxThresh?: number;
  detBoxScoreThresh?: number;
  detUnclipRatio?: number;
}

export interface OcrPpocrOptions extends OcrDbDetectorOptions {
  maxSideLen?: number;
  useOrientationCls?: boolean;
}

export type OcrDoctrOptions = OcrDbDetectorOptions;

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
export const PADDLEOCR_VL_SPOTTING_MAX_PIXELS = 1605632;
/** Phone-oriented cap (512 visual tokens). Pass via `paddleocrVl.maxPixels`. */
export const PADDLEOCR_VL_MOBILE_MAX_PIXELS = 401408;

/** Official PaddleOCR-VL control-prompt task. Omit → `'ocr'`. */
export type OcrPaddleocrVlTask =
  | 'ocr'
  | 'table'
  | 'formula'
  | 'chart'
  | 'seal'
  | 'spotting';

export type OcrPaddleocrVlOptions = {
  /**
   * `smart_resize` area cap applied as `min(cap, taskDefault)`.
   * Omit or `0` → the task default (`PADDLEOCR_VL_OFFICIAL_MAX_PIXELS`, or
   * {@link PADDLEOCR_VL_SPOTTING_MAX_PIXELS} for spotting).
   * Recognize-time task lives on {@link OcrRecognizeOptionsOf} `instruction`.
   */
  maxPixels?: number;
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

export type OcrRecognizeOptionsBase = {
  /** Frame indices to run; default = all frames in the image buffer. */
  frames?: number[];
  /** Span level filter (default `'line'`). */
  granularity?: OcrGranularity;
  /** Engine-level crop applied before family preprocessing. */
  crop?: OcrPixelRect;
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

/** Granite decode after a DocTags prefix / prompt-only reject.
 *  Default `'accepted'` stops so the SDK parser does not wait on a stream it
 *  will not use. `'full'` keeps generating through EOS / `maxNewTokens` so a
 *  custom parser can read the complete model answer on `result.raw`. */
export type OcrVlmRawMode = 'accepted' | 'full';

export type OcrRecognizeOptionsOf<F extends OcrFamily> =
  F extends OcrInstructionFamily
    ? OcrRecognizeOptionsBase & {
        instruction?: OcrInstructionOf<F>;
        raw?: OcrVlmRawMode;
      }
    : OcrRecognizeOptionsBase;

/** Untyped recognize options (union engines / JS). */
export type OcrRecognizeOptions = OcrRecognizeOptionsBase & {
  instruction?:
    | OcrDocVlmInstruction
    | OcrNemotronParseInstruction
    | OcrPaddleocrVlInstruction;
  raw?: OcrVlmRawMode;
};

/** Why a VLM greedy decode stopped. `invalid_sequence` is Granite-only: the
 *  stream left the DocTags grammar. Default `raw: 'accepted'` stops decode
 *  there; `raw: 'full'` continues so `result.raw` is the complete stream. */
export type OcrVlmStopReason =
  | 'doctag_end'
  | 'eos'
  | 'max_new_tokens'
  | 'invalid_sequence';

/** @deprecated Use {@link OcrVlmStopReason}. */
export type OcrDocVlmStopReason = OcrVlmStopReason;

export type OcrStopReasonOf<F extends OcrInstructionFamily> = {
  doc_vlm: 'doctag_end' | 'eos' | 'max_new_tokens' | 'invalid_sequence';
  nemotron_parse: 'eos' | 'max_new_tokens';
  paddleocr_vl: 'eos' | 'max_new_tokens';
}[F];

export type OcrContent =
  | { format: 'markdown'; value: string }
  | { format: 'plain'; value: string }
  | { format: 'latex'; value: string }
  | { format: 'code'; value: string; language: string | null };

export type OcrElementKind =
  | 'text'
  | 'title'
  | 'sectionHeader'
  | 'listItem'
  | 'caption'
  | 'footnote'
  | 'pageHeader'
  | 'pageFooter'
  | 'formula'
  | 'code'
  | 'table'
  | 'picture'
  | 'chart'
  | 'tableOfContents'
  | 'bibliography'
  | 'checkbox'
  | 'form'
  | 'keyValueRegion';

export type OcrQuad = {
  xy: [number, number, number, number, number, number, number, number];
};

export interface OcrElement {
  kind: OcrElementKind;
  frameIndex: number;
  quad: OcrQuad | null;
  utf16Start: number | null;
  utf16End: number | null;
  headingLevel: number | null;
  checked: boolean | null;
}

type OcrVlmRecognizeShared<F extends OcrInstructionFamily> = {
  family: F;
  instruction: OcrInstructionOf<F>;
  spanCount: number;
  /** Decoded model stream. Present even when `content` / `elements` stay empty. */
  raw: string;
  content: OcrContent | null;
  elements: OcrElement[];
  complete: boolean;
  stopReason: OcrStopReasonOf<F>;
};

/**
 * Result of `OcrEngine.recognize`. Plain text and spans live on `textOut`.
 * Discriminated on `family`.
 */
export type OcrRecognizeResult =
  | { family: 'ppocr'; spanCount: number }
  | { family: 'doctr'; spanCount: number }
  | OcrVlmRecognizeShared<'doc_vlm'>
  | OcrVlmRecognizeShared<'nemotron_parse'>
  | OcrVlmRecognizeShared<'paddleocr_vl'>;

export type OcrRecognizeResultOf<F extends OcrFamily> =
  F extends OcrInstructionFamily
    ? OcrVlmRecognizeShared<F>
    : F extends 'ppocr' | 'doctr'
    ? { family: F; spanCount: number }
    : never;

/** @deprecated Use {@link OcrDetectModelResult} from `../types/modelDetect`. */
export type OcrDetectResult = OcrDetectModelResult;

export interface OcrEngineOf<F extends OcrFamily> {
  readonly instanceId: string;
  readonly family: F;
  readonly capabilities: OcrCapabilitiesOf<F>;
  recognize(
    imageBuffer: OfflineImageBufferIdSource,
    textOut: OfflineTextBufferIdSource,
    options?: OcrRecognizeOptionsOf<F>
  ): Promise<OcrRecognizeResultOf<F>>;
  destroy(): Promise<void>;
}

/** A real union so `engine.family === …` narrows. */
export type OcrEngine = { [F in OcrFamily]: OcrEngineOf<F> }[OcrFamily];

/** Maps `createOCR({ modelType })` onto a family-typed engine. */
export type OcrEngineForInit<O extends OcrInitializeOptions> = O extends {
  modelType: infer T;
}
  ? T extends OcrFamily
    ? OcrEngineOf<T>
    : OcrEngine
  : OcrEngine;

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
  INSTRUCTION_FAMILY_MISMATCH: 'OCR_INSTRUCTION_FAMILY_MISMATCH',
  INSTRUCTION_UNSUPPORTED: 'OCR_INSTRUCTION_UNSUPPORTED',
  INVALID_REGION: 'OCR_INVALID_REGION',
  UNSUPPORTED_GRANULARITY: 'OCR_UNSUPPORTED_GRANULARITY',
  INVALID_RECOGNIZE_SPEC: 'OCR_INVALID_RECOGNIZE_SPEC',
  PARSE_UNKNOWN_KIND: 'OCR_PARSE_UNKNOWN_KIND',
  CAPABILITIES_MISMATCH: 'OCR_CAPABILITIES_MISMATCH',
} as const;

export type OcrErrorCodeValue =
  (typeof OcrErrorCode)[keyof typeof OcrErrorCode];
