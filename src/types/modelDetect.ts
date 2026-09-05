import type { PublicLanguageHint } from '../model-languages';

// ─── Detection source (shared across all feature detectors) ──────────────

/** How native detection chose the model kind (mirrors C++ DetectionSource). */
export const DETECTION_SOURCES = [
  'fileListing',
  'dirName',
  'fallbackOrder',
  'explicitModelType',
  'nameOnly',
  'curatedCatalog',
] as const;

export type DetectionSource = (typeof DETECTION_SOURCES)[number];

export function isDetectionSource(s: string): s is DetectionSource {
  return (DETECTION_SOURCES as readonly string[]).includes(s);
}

// ─── Detected model entry (shared) ──────────────────────────────────────

/** One detected model stack under a model directory (native may return unknown `type` strings). */
export type DetectedModelEntry = {
  type: string;
  modelDir: string;
};

// ─── Base detect result (shared across TTS, Alignment, future features) ─

export interface ModelDetectResultBase {
  success: boolean;
  /** Native validation/detect failure message. */
  error?: string;
  detectedModels: DetectedModelEntry[];
  /** Primary detected kind string. */
  modelType?: string;
  /**
   * Whether the detected model supports streaming inference.
   * For STT: supplied by native detection with online-compatibility guard
   * (safe ORT metadata/shape inspection; falls back to heuristic in name-only mode).
   * For TTS: always `true`.
   * For Enhancement: supplied by native detection with online-compatibility preflight
   * (`success=false` can still occur in name-only heuristic mode).
   * For Punctuation: `true` for CNN-BiLSTM (online) when the ORT preflight passes; `false` for
   * offline CT-Transformer; heuristics mirror Enhancement when files are not on disk.
   * For Alignment: always `false`.
   */
  isStreaming: boolean;
  /** Normalized primary hints (`iso6391Hint`); from native heuristics + SDK fallback. */
  languages?: PublicLanguageHint[];
  /** fp16, int8, int8-quantized, unknown — from name heuristics. */
  quantization?: string;
  /** Trace of how native detection chose the model kind. */
  detectionSources?: readonly DetectionSource[];
}

// ─── TTS extension ──────────────────────────────────────────────────────

export type TtsLexiconLanguage = {
  id: string;
  path: string;
};

export interface TtsDetectModelResult extends ModelDetectResultBase {
  /** tiny, small, medium, large, unknown — from name heuristics. */
  sizeTier?: string;
  /**
   * Lexicon files detected on disk (`lexicon.txt`, `lexicon-*.txt`).
   * Use with init `lexiconLanguageId` (vits/matcha/kokoro/zipvoice). Not kitten/pocket/supertonic.
   * Not the same as catalog `languages` hints.
   */
  lexiconLanguages?: ReadonlyArray<TtsLexiconLanguage>;
  /** Resolved non-empty path keys from native file-based detection. */
  paths?: Readonly<Record<string, string>>;
}

// ─── STT extension ──────────────────────────────────────────────────────

export interface SttDetectModelResult extends ModelDetectResultBase {
  /** True when model targets unsupported hardware-specific acceleration (RK35xx, Ascend, CANN). */
  isHardwareSpecificUnsupported?: boolean;
  /** Resolved non-empty path keys from native file-based detection. */
  paths?: Readonly<Record<string, string>>;
}

// ─── Enhancement extension ─────────────────────────────────────────────

export interface EnhancementDetectModelResult extends ModelDetectResultBase {
  /** Resolved model file path from detection. */
  paths?: {
    model?: string;
  };
}

// ─── Speaker embedding extension ───────────────────────────────────────

export interface SpeakerEmbeddingDetectModelResult
  extends ModelDetectResultBase {
  /** Resolved embedding extractor ONNX path from detection. */
  paths?: {
    model?: string;
  };
}

// ─── Diarization extension ─────────────────────────────────────────────

export interface DiarizationDetectModelResult extends ModelDetectResultBase {
  /** Resolved segmentation ONNX path and optional metadata JSON from detection. */
  paths?: {
    model?: string;
    metadata?: string;
  };
}

// ─── Source separation extension ───────────────────────────────────────

export interface SeparationDetectModelResult extends ModelDetectResultBase {
  /** Spleeter: vocals + accompaniment; UVR: single model ONNX. */
  paths?: {
    vocals?: string;
    accompaniment?: string;
    model?: string;
  };
}

// ─── Alignment extension ────────────────────────────────────────────────

export interface AlignmentDetectModelResult extends ModelDetectResultBase {
  /** Resolved model file path from detection (wav2vec2 model). */
  paths?: {
    model?: string;
  };
}

// ─── VAD extension ──────────────────────────────────────────────────────

export interface VadDetectModelResult extends ModelDetectResultBase {
  /** Resolved model file path from detection. */
  paths?: {
    model?: string;
  };
}

// ─── Punctuation extension ────────────────────────────────────────────────

export interface PunctuationDetectModelResult extends ModelDetectResultBase {
  /** Resolved paths (offline: ct_transformer; online: cnn_bilstm + bpe_vocab). */
  paths?: {
    ct_transformer?: string;
    cnn_bilstm?: string;
    bpe_vocab?: string;
  };
}
