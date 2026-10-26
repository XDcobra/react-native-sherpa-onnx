import type { PublicLanguageHint } from '../model-languages';
import type {
  Quantization,
  QuantizationPreference,
  SizeTier,
} from '../download/types';

export type { Quantization, QuantizationPreference, SizeTier };

export function normalizeQuantization(raw: unknown): Quantization | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const lower = raw.trim().toLowerCase();
  if (
    lower === 'int8' ||
    lower === 'int8-quantized' ||
    lower === 'fp16' ||
    lower === 'int4' ||
    lower === 'uint8' ||
    lower === 'fp32' ||
    lower === 'bf16' ||
    lower === 'q8' ||
    lower === 'q4f16'
  ) {
    return lower as Quantization;
  }
  return 'unknown';
}

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
  /** fp16, int8, int8-quantized, int4, uint8, fp32, bf16, q8, q4f16, unknown — from name heuristics or file detection. */
  quantization?: Quantization;
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
  /**
   * Resolved paths from detection.
   * `model` is the ONNX; `vocab` is optional sidecar HF vocab.json.
   */
  paths?: {
    model?: string;
    vocab?: string;
  };
}

// ─── OCR extension ──────────────────────────────────────────────────────

export interface OcrDetectModelResult extends ModelDetectResultBase {
  /**
   * Always `false` — OCR packs are offline multi-file layouts (no streaming
   * session contract; no ORT online-guard).
   */
  // isStreaming from base
  /** tiny / small / medium / large / unknown — from pack basename heuristics. */
  sizeTier?: SizeTier;
  paths?: {
    det?: string;
    rec?: string;
    cls?: string;
    /** Recognition dictionary (yml/txt); native key `rec_dict`. */
    rec_dict?: string;
    /** `ocr_manifest.json` — doctr and doc_vlm. */
    manifest?: string;
    /** `vision_encoder.onnx` — doc_vlm. */
    vision_encoder?: string;
    /** `vision_encoder.onnx_data` — doc_vlm. */
    vision_encoder_data?: string;
    /** `embed_tokens.onnx` — doc_vlm. */
    embed_tokens?: string;
    /** `embed_tokens.onnx_data` — doc_vlm. */
    embed_tokens_data?: string;
    /** `decoder_model_merged.onnx` — doc_vlm. */
    decoder?: string;
    /** `decoder_model_merged.onnx_data` — doc_vlm. */
    decoder_data?: string;
    /** `tokenizer.json` — doc_vlm / nemotron_parse. */
    tokenizer?: string;
    /** `patch_embed.onnx` — nemotron_parse. */
    patch_embed?: string;
    /** `patch_embed.onnx_data` — nemotron_parse. */
    patch_embed_data?: string;
    /** `pos_embed.npy` — nemotron_parse. */
    pos_embed?: string;
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

// ─── Spoken language identification (SLID) extension ───────────────────

export interface LanguageIdDetectModelResult extends ModelDetectResultBase {
  /** Resolved model files (encoder + decoder ONNX). */
  paths?: {
    encoder?: string;
    decoder?: string;
  };
}

// ─── Keyword spotting extension ────────────────────────────────────────

export interface KwsDetectModelResult extends ModelDetectResultBase {
  /** Resolved online transducer files plus the required keyword list. */
  paths?: {
    encoder?: string;
    decoder?: string;
    joiner?: string;
    tokens?: string;
    keywords?: string;
  };
}

// ─── Audio tagging extension ───────────────────────────────────────────

export interface AudioTaggingDetectModelResult extends ModelDetectResultBase {
  /** Resolved offline pack files (ONNX model + class_labels_indices.csv). */
  paths?: {
    model?: string;
    labels?: string;
  };
}
