import type { PublicLanguageHint } from '../model-languages';

// ─── Detection source (shared across all feature detectors) ──────────────

/** How native detection chose the model kind (mirrors C++ DetectionSource). */
export const DETECTION_SOURCES = [
  'fileListing',
  'dirName',
  'fallbackOrder',
  'explicitModelType',
  'nameOnly',
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
  /** Normalized primary hints (`iso6391Hint`); from native heuristics + SDK fallback. */
  languages?: PublicLanguageHint[];
  /** fp16, int8, int8-quantized, unknown — from name heuristics. */
  quantization?: string;
  /** Trace of how native detection chose the model kind. */
  detectionSources?: readonly DetectionSource[];
}

// ─── TTS extension ──────────────────────────────────────────────────────

export interface TtsDetectModelResult extends ModelDetectResultBase {
  /** tiny, small, medium, large, unknown — from name heuristics. */
  sizeTier?: string;
  /** Language ids from detected lexicon files (Kokoro/Kitten). */
  lexiconLanguageCandidates?: string[];
}

// ─── STT extension ──────────────────────────────────────────────────────

export interface SttDetectModelResult extends ModelDetectResultBase {
  /** True when model targets unsupported hardware-specific acceleration (RK35xx, Ascend, CANN). */
  isHardwareSpecificUnsupported?: boolean;
}

// ─── Enhancement extension ─────────────────────────────────────────────

export interface EnhancementDetectModelResult extends ModelDetectResultBase {
  /** Resolved model file path from detection. */
  paths?: {
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
