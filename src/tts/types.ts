import type { FileSource } from '../fileio/types';
import type { DetectedModelEntry } from '../types/modelDetect';
import type {
  OfflineAudioBufferRef,
  OfflineBufferHandle,
} from '../audiobuffer/types';
import type {
  OfflineTextBufferRef,
  OfflineTextBufferHandle,
} from '../textbuffer/types';
import type {
  ErrorRecoveryStrategy,
  FailedSegmentInfo,
  OrchestrationProgress,
  RetryExhaustedFallback,
  SkippedSegmentInfo,
} from '../pipeline/offlineOrchestrator';
import type { SegmentationPolicy } from '../segment/engine-types';
import type { SegmentLinkMapRef } from '../segment/segment-link';

/**
 * Supported TTS model types.
 *
 * - 'vits': VITS models (includes Piper, Coqui, MeloTTS, MMS variants)
 * - 'matcha': Matcha models (acoustic model + vocoder)
 * - 'kokoro': Kokoro models (multi-speaker, multi-language)
 * - 'kitten': KittenTTS models (lightweight, multi-speaker)
 * - 'pocket': Pocket TTS models
 * - 'zipvoice': Zipvoice models (voice cloning capable)
 * - 'supertonic': Supertonic models
 * - 'auto': Auto-detect model type based on files present (default)
 */
export type TTSModelType =
  | 'vits'
  | 'matcha'
  | 'kokoro'
  | 'kitten'
  | 'pocket'
  | 'zipvoice'
  | 'supertonic'
  | 'auto';

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type TtsDetectModelResult,
  type AlignmentDetectModelResult,
  type ModelDetectResultBase,
} from '../types/modelDetect';

/** Runtime list of supported TTS model types. */
export const TTS_MODEL_TYPES: readonly TTSModelType[] = [
  'vits',
  'matcha',
  'kokoro',
  'kitten',
  'pocket',
  'zipvoice',
  'supertonic',
  'auto',
] as const;

/** Runtime guard for model kind literals returned from native detection. */
export function isTtsModelType(s: string): s is TTSModelType {
  return (TTS_MODEL_TYPES as readonly string[]).includes(s);
}

/**
 * ONNX Runtime execution provider string passed to native TTS init.
 * Extend with `(string & {})` so callers can pass future/custom provider ids.
 */
export type TtsExecutionProvider =
  | 'cpu'
  | 'coreml'
  | 'xnnpack'
  | 'nnapi'
  | 'qnn'
  | (string & {});

// ========== Model-specific options (only applied when that model type is loaded) ==========

/** Options for VITS models. Applied only when modelType is 'vits'. Kotlin OfflineTtsVitsModelConfig. */
export interface TtsVitsModelOptions {
  /** Noise scale. If omitted, model default (or model.json) is used. */
  noiseScale?: number;
  /** Noise scale W. If omitted, model default is used. */
  noiseScaleW?: number;
  /** Length scale. If omitted, model default is used. */
  lengthScale?: number;
}

/** Options for Matcha models. Applied only when modelType is 'matcha'. Kotlin OfflineTtsMatchaModelConfig. */
export interface TtsMatchaModelOptions {
  /** Noise scale. If omitted, model default is used. */
  noiseScale?: number;
  /** Length scale. If omitted, model default is used. */
  lengthScale?: number;
}

/** Options for Kokoro models. Applied only when modelType is 'kokoro'. Kotlin OfflineTtsKokoroModelConfig. */
export interface TtsKokoroModelOptions {
  /** Length scale. If omitted, model default is used. */
  lengthScale?: number;
}

/** Options for KittenTTS models. Applied only when modelType is 'kitten'. Kotlin OfflineTtsKittenModelConfig. */
export interface TtsKittenModelOptions {
  /** Length scale. If omitted, model default is used. */
  lengthScale?: number;
}

/** Options for Pocket TTS models. Applied only when modelType is 'pocket'. Kotlin has no init-time model config for pocket; reserved for future use. */
export interface TtsPocketModelOptions {
  // No init-time options in Kotlin OfflineTtsPocketModelConfig; voice cloning is via GenerationConfig at generate time.
}

/** Options for Supertonic models. Applied only when modelType is 'supertonic'. */
export interface TtsSupertonicModelOptions {
  // No init-time model options exposed by sherpa-onnx currently.
}

/**
 * Aggregate of per-model init/update blocks for the native bridge.
 * Prefer {@link TTSInitializeOptions} / {@link TtsUpdateOptions} discriminated unions in app code.
 */
export interface TtsModelOptions {
  vits?: TtsVitsModelOptions;
  matcha?: TtsMatchaModelOptions;
  kokoro?: TtsKokoroModelOptions;
  kitten?: TtsKittenModelOptions;
  pocket?: TtsPocketModelOptions;
  supertonic?: TtsSupertonicModelOptions;
}

/** Shared init fields (excluding modelType / modelOptions). */
export type TTSInitializeOptionsBase = {
  /**
   * Path to the model directory.
   * Can be an asset path, file system path, or auto-detection path.
   */
  modelSource: FileSource;

  /**
   * Execution provider (e.g. `'cpu'`, `'coreml'`, `'xnnpack'`, `'nnapi'`, `'qnn'`).
   * Use getCoreMlSupport(), getXnnpackSupport(), etc. to check availability. See execution-providers.md.
   *
   * @default 'cpu'
   */
  provider?: TtsExecutionProvider;

  /**
   * Number of threads to use for inference.
   * More threads = faster processing but more CPU usage.
   *
   * @default 2
   */
  numThreads?: number;

  /**
   * Enable debug logging from the TTS engine.
   *
   * @default false
   */
  debug?: boolean;

  /**
   * Path(s) to rule FSTs for TTS (OfflineTtsConfig.ruleFsts).
   * Used for text normalization / ITN.
   */
  ruleFsts?: string;

  /**
   * Path(s) to rule FARs for TTS (OfflineTtsConfig.ruleFars).
   * Used for text normalization / ITN.
   */
  ruleFars?: string;

  /**
   * Max number of sentences per streaming callback (OfflineTtsConfig.maxNumSentences).
   * Default: 1.
   */
  maxNumSentences?: number;

  /**
   * Silence scale on config level (OfflineTtsConfig.silenceScale).
   * Default: 0.2.
   */
  silenceScale?: number;
};

/** `modelType` omitted or `'auto'`: no `modelOptions` (set an explicit `modelType` to pass scales). */
export type TTSInitializeOptionsAuto = TTSInitializeOptionsBase & {
  modelType?: 'auto' | undefined;
  modelOptions?: never;
};

export type TTSInitializeOptionsVits = TTSInitializeOptionsBase & {
  modelType: 'vits';
  modelOptions?: { vits: TtsVitsModelOptions };
};

export type TTSInitializeOptionsMatcha = TTSInitializeOptionsBase & {
  modelType: 'matcha';
  modelOptions?: { matcha: TtsMatchaModelOptions };
};

export type TTSInitializeOptionsKokoro = TTSInitializeOptionsBase & {
  modelType: 'kokoro';
  modelOptions?: { kokoro: TtsKokoroModelOptions };
};

export type TTSInitializeOptionsKitten = TTSInitializeOptionsBase & {
  modelType: 'kitten';
  modelOptions?: { kitten: TtsKittenModelOptions };
};

export type TTSInitializeOptionsPocket = TTSInitializeOptionsBase & {
  modelType: 'pocket';
  modelOptions?: never;
};

export type TTSInitializeOptionsZipvoice = TTSInitializeOptionsBase & {
  modelType: 'zipvoice';
  modelOptions?: never;
};

export type TTSInitializeOptionsSupertonic = TTSInitializeOptionsBase & {
  modelType: 'supertonic';
  modelOptions?: never;
};

/**
 * Configuration for TTS initialization. Discriminated by `modelType`:
 * with `'auto'` or omitted, `modelOptions` is not allowed; with a concrete synthesizer type, only the matching `modelOptions` block is allowed.
 */
export type TTSInitializeOptions =
  | TTSInitializeOptionsAuto
  | TTSInitializeOptionsVits
  | TTSInitializeOptionsMatcha
  | TTSInitializeOptionsKokoro
  | TTSInitializeOptionsKitten
  | TTSInitializeOptionsPocket
  | TTSInitializeOptionsZipvoice
  | TTSInitializeOptionsSupertonic;

/** No runtime parameter change. */
export type TtsUpdateOptionsEmpty = {
  modelType?: never;
  modelOptions?: never;
};

export type TtsUpdateOptionsAuto = {
  modelType?: 'auto';
  modelOptions?: never;
};

export type TtsUpdateOptionsVits = {
  modelType: 'vits';
  modelOptions?: { vits: TtsVitsModelOptions };
};

export type TtsUpdateOptionsMatcha = {
  modelType: 'matcha';
  modelOptions?: { matcha: TtsMatchaModelOptions };
};

export type TtsUpdateOptionsKokoro = {
  modelType: 'kokoro';
  modelOptions?: { kokoro: TtsKokoroModelOptions };
};

export type TtsUpdateOptionsKitten = {
  modelType: 'kitten';
  modelOptions?: { kitten: TtsKittenModelOptions };
};

export type TtsUpdateOptionsPocket = {
  modelType: 'pocket';
  modelOptions?: never;
};

export type TtsUpdateOptionsZipvoice = {
  modelType: 'zipvoice';
  modelOptions?: never;
};

export type TtsUpdateOptionsSupertonic = {
  modelType: 'supertonic';
  modelOptions?: never;
};

/**
 * Options for updating TTS model parameters at runtime.
 * Only the block matching `modelType` is applied. Use `{}` for a no-op update.
 */
export type TtsUpdateOptions =
  | TtsUpdateOptionsEmpty
  | TtsUpdateOptionsAuto
  | TtsUpdateOptionsVits
  | TtsUpdateOptionsMatcha
  | TtsUpdateOptionsKokoro
  | TtsUpdateOptionsKitten
  | TtsUpdateOptionsPocket
  | TtsUpdateOptionsZipvoice
  | TtsUpdateOptionsSupertonic;

export type SubtitleMode = 'off' | 'proportional' | 'estimated' | 'accurate';
export type SubtitleGranularity = 'sentence' | 'word' | 'character';

/** Zipvoice cloning: reference audio from OfflineAudioBuffer; prompt text required. */
export type TtsVoiceCloneZipvoice = {
  kind: 'zipvoice';
  referenceAudio: OfflineAudioBufferRef | OfflineBufferHandle;
  referenceText: string;
};

/** Pocket cloning: reference audio from OfflineAudioBuffer; transcript optional. */
export type TtsVoiceClonePocket = {
  kind: 'pocket';
  referenceAudio: OfflineAudioBufferRef | OfflineBufferHandle;
  referenceText?: string;
};

export type TtsVoiceClone = TtsVoiceCloneZipvoice | TtsVoiceClonePocket;

/**
 * Options for buffer-to-buffer TTS synthesis via `tts.synthesize()`.
 * No subtitle/alignment options — those are separate modules.
 *
 * Note: `silenceScale` and `numSteps` are only applied when `voiceClone` is
 * provided. They are ignored for non-cloning synthesis (native code only reads
 * them inside the voice-clone config).
 */
export type TtsSynthesisOptions = {
  sid?: number;
  speed?: number;
  silenceScale?: number;
  numSteps?: number;
  extra?: Record<string, string>;
  voiceClone?: TtsVoiceClone;
  segmentation?: {
    mode?: 'off' | 'manual' | 'auto';
    policy?: SegmentationPolicy;
  };
  errorRecovery?: ErrorRecoveryStrategy;
  maxRetriesPerSegment?: number;
  retryExhaustedFallback?: RetryExhaustedFallback;
  abortSignal?: AbortSignal;
  onProgress?: (progress: OrchestrationProgress) => void;
  overlapChars?: number;
  textSkipPlaceholder?: string;
  linkMap?: SegmentLinkMapRef;
};

export interface TtsSynthesisResult {
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  totalSegments: number;
  completedSegments: number;
  skippedSegments: SkippedSegmentInfo[];
  failedSegment?: FailedSegmentInfo;
  processingTimeMs: number;
  linkMap?: SegmentLinkMapRef;
}

/**
 * Instance-based batch TTS engine returned by createTTS().
 * Use synthesize() for buffer-to-buffer offline synthesis.
 * For streaming, use createStreamingTTS() and StreamingTtsEngine instead.
 * Call destroy() when done to free native resources.
 */
export interface TtsEngine {
  readonly instanceId: string;
  /**
   * Buffer-to-buffer offline TTS synthesis.
   * Reads text from an OfflineTextBuffer and writes audio into an empty OfflineAudioBuffer.
   *
   * @param textIn - Offline text buffer (input text source)
   * @param audioOut - Empty offline audio buffer (output target); sampleRate must match model output rate
   * @param options - Synthesis options (sid, speed, voiceClone, etc.)
   */
  synthesize(
    textIn: OfflineTextBufferRef | OfflineTextBufferHandle,
    audioOut: OfflineAudioBufferRef | OfflineBufferHandle,
    options?: TtsSynthesisOptions
  ): Promise<TtsSynthesisResult>;
  updateParams(options: TtsUpdateOptions): Promise<{
    success: boolean;
    detectedModels: DetectedModelEntry[];
  }>;
  getModelInfo(): Promise<TTSModelInfo>;
  getSampleRate(): Promise<number>;
  getNumSpeakers(): Promise<number>;
  destroy(): Promise<void>;
}

/**
 * Information about TTS model capabilities.
 */
export interface TTSModelInfo {
  /**
   * Sample rate that the model generates audio at.
   */
  sampleRate: number;

  /**
   * Number of speakers/voices available in the model.
   * - 0 or 1: Single-speaker model
   * - >1: Multi-speaker model
   */
  numSpeakers: number;
}

/** Save TTS audio to an absolute file path (include extension matching `format`, e.g. `.wav`, `.mp3`). */
export type SaveAudioTargetFile = { kind: 'file'; path: string };

/**
 * Save TTS audio via Android Storage Access Framework into a user-granted directory tree.
 * **Android only** — throws on other platforms.
 */
export type SaveAudioTargetAndroidContent = {
  kind: 'androidContent';
  directoryUri: string;
  filename: string;
};

export type SaveAudioTarget =
  | SaveAudioTargetFile
  | SaveAudioTargetAndroidContent;
