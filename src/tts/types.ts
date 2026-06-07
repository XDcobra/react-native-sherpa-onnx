import type { FileSource } from '../fileio/types';
import type { DetectedModelEntry } from '../types/modelDetect';
import type {
  OfflineAudioBufferRef,
  OfflineBufferHandle,
  LiveAudioBufferIdSource,
} from '../audiobuffer/types';
import type {
  OfflineTextBufferRef,
  OfflineTextBufferHandle,
  LiveTextBufferIdSource,
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
import type { LiveOfflinePipelineBaseOptions } from '../livePipeline';
import type { SpeechSegment } from '../segment/segment';
import type { StreamingPipelineHandle } from '../audiobuffer/streamingPipelineTypes';

/** TTS-specific pipeline handle returned by live pipeline synthesis. */
export interface TtsPipelineHandle extends StreamingPipelineHandle {
  readonly instanceId: string;
}

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

/** Concrete TTS model types (excludes `'auto'`). */
export type TTSConcreteModelType = Exclude<TTSModelType, 'auto'>;

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

// ========== TTS language (init vs synthesize) ==========
//
// See `languagePolicy.ts`: lexicon file at init (`lexiconLanguageId`), Kokoro init lang
// (`modelOptions.kokoro.lang`), runtime lang (`synthesize({ lang })` → extra["lang"]).
//
// Lexikon-Wechsel ⇒ re-init. eSpeak (data_dir) is init-only — not synthesize.lang. Runtime lang
// is effective for kokoro + supertonic only; vits/matcha/kitten ignore extra["lang"]. Detect
// `languages` is catalog metadata only. synthesize.lang does not replace lexicon file selection.

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

/**
 * Options for Kokoro models. Applied only when modelType is 'kokoro'.
 * Kotlin OfflineTtsKokoroModelConfig.
 *
 * Init `lang` is separate from {@link TTSAutoInitOptionsBase.lexiconLanguageId} (lexicon file)
 * and from {@link TtsSynthesisOptions.lang} (per-synthesis override).
 */
export interface TtsKokoroModelOptions {
  /** Length scale. If omitted, model default is used. */
  lengthScale?: number;
  /**
   * Kokoro init language / voice hint (`config.model.kokoro.lang`).
   * Multi-Kokoro v2+: satisfies init when no lexicon path is set (upstream: lexicon or lang).
   * Default for synthesis unless overridden by `tts.synthesize({ lang })`.
   *
   * No-op for non-kokoro model types. Does not load a different lexicon file — use
   * `lexiconLanguageId` on the init options and re-initialize to switch lexicon-*.txt.
   */
  lang?: string;
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

/** Shared TTS init fields for auto and custom modes. */
export type TTSInitOptionsShared = {
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

/** Automatic model detection from a model directory (default). */
export type TTSAutoInitOptionsBase = TTSInitOptionsShared & {
  initMode?: 'auto';
  /**
   * Path to the model directory.
   * Can be an asset path, file system path, or auto-detection path.
   */
  modelSource: FileSource;

  /**
   * Which detected lexicon file to load at init, from `detectTtsModel().lexiconLanguages`
   *
   * Supported model types: `vits`, `matcha`, `kokoro`, `zipvoice`. No-op for `kitten` (no lexicon
   * field), `pocket`, `supertonic`. Changing this requires a new `createTTS()` (engine re-init).
   *
   * Not the same as catalog `languages` hints or `synthesize({ lang })`. For VITS Piper, if the
   * bundle uses `espeak-ng-data` (`data_dir`), upstream may ignore `lexicon` when `data_dir` is set.
   */
  lexiconLanguageId?: string;
};

/** Alias for auto-init shared fields (includes `modelSource`). */
export type TTSInitializeOptionsBase = TTSAutoInitOptionsBase;

type TtsCustomModelOptionsFor<T extends TTSConcreteModelType> = T extends 'vits'
  ? { modelOptions?: { vits: TtsVitsModelOptions } }
  : T extends 'matcha'
  ? { modelOptions?: { matcha: TtsMatchaModelOptions } }
  : T extends 'kokoro'
  ? { modelOptions?: { kokoro: TtsKokoroModelOptions } }
  : T extends 'kitten'
  ? { modelOptions?: { kitten: TtsKittenModelOptions } }
  : { modelOptions?: never };

/** Explicit per-file paths; skips native auto-detection. */
export type TTSCustomInitializeOptions<
  T extends TTSConcreteModelType = TTSConcreteModelType
> = TTSInitOptionsShared & {
  initMode: 'custom';
  modelType: T;
  customConfig: import('./customConfig').TtsCustomConfigByModelType[T];
} & TtsCustomModelOptionsFor<T>;

/** `modelType` omitted or `'auto'`: no `modelOptions` (set an explicit `modelType` to pass scales). */
export type TTSInitializeOptionsAuto = TTSAutoInitOptionsBase & {
  modelType?: 'auto' | undefined;
  modelOptions?: never;
};

export type TTSInitializeOptionsVits = TTSAutoInitOptionsBase & {
  modelType: 'vits';
  modelOptions?: { vits: TtsVitsModelOptions };
};

export type TTSInitializeOptionsMatcha = TTSAutoInitOptionsBase & {
  modelType: 'matcha';
  modelOptions?: { matcha: TtsMatchaModelOptions };
};

export type TTSInitializeOptionsKokoro = TTSAutoInitOptionsBase & {
  modelType: 'kokoro';
  modelOptions?: { kokoro: TtsKokoroModelOptions };
};

export type TTSInitializeOptionsKitten = TTSAutoInitOptionsBase & {
  modelType: 'kitten';
  modelOptions?: { kitten: TtsKittenModelOptions };
};

export type TTSInitializeOptionsPocket = TTSAutoInitOptionsBase & {
  modelType: 'pocket';
  modelOptions?: never;
};

export type TTSInitializeOptionsZipvoice = TTSAutoInitOptionsBase & {
  modelType: 'zipvoice';
  modelOptions?: never;
};

export type TTSInitializeOptionsSupertonic = TTSAutoInitOptionsBase & {
  modelType: 'supertonic';
  modelOptions?: never;
};

export type TTSAutoInitializeOptions =
  | TTSInitializeOptionsAuto
  | TTSInitializeOptionsVits
  | TTSInitializeOptionsMatcha
  | TTSInitializeOptionsKokoro
  | TTSInitializeOptionsKitten
  | TTSInitializeOptionsPocket
  | TTSInitializeOptionsZipvoice
  | TTSInitializeOptionsSupertonic;

/**
 * Configuration for TTS initialization. Discriminated by `initMode` and `modelType`:
 * auto mode scans a model directory; custom mode supplies explicit {@link FileSource} paths.
 */
export type TTSInitializeOptions =
  | TTSAutoInitializeOptions
  | TTSCustomInitializeOptions;

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
 * **Language:** `lang` is forwarded as `GenerationConfig.extra["lang"]` when the native batch path
 * uses `generateWithConfig`. Upstream **honors** it only for `kokoro` and `supertonic`. For `vits`,
 * `matcha`, and `kitten` it is ignored (eSpeak is init-only via `data_dir`, not per-synthesis `lang`).
 * For `zipvoice` / `pocket`, use `voiceClone` and model-specific `extra` keys — not `lang`.
 * Use {@link supportsSynthesisLang} from `./languagePolicy` before UI promises.
 *
 * `lang` does **not** switch the lexicon file loaded at init; use `lexiconLanguageId` + re-init.
 *
 * `silenceScale` and `numSteps` apply only with `voiceClone` (ignored otherwise).
 */
export type TtsSynthesisOptions = {
  sid?: number;
  speed?: number;
  silenceScale?: number;
  numSteps?: number;
  /**
   * Runtime language hint. Prefer this over `extra.lang` (same native key; this wins on conflict).
   *
   * **Effective:** `kokoro` (overrides `modelOptions.kokoro.lang`), `supertonic` (upstream: `en`, `ko`, `es`, `pt`, `fr`).
   * **Ignored (no-op):** `vits`, `matcha`, `kitten` — passing `lang` does not change output language.
   * **Not applicable:** `zipvoice`, `pocket` (voice-clone models).
   */
  lang?: string;
  /** Additional generation extras. For `lang`, prefer the `lang` property above. */
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
 * Options for the live offline TTS pipeline overload.
 * Extends `LiveOfflinePipelineBaseOptions` which requires `segmentation.policy`
 * with a text-domain evaluator (e.g. `text_synthetic_auto`).
 *
 * See: docs/migration/liveOverload/sub-05-tts-live-overload.md
 * See: docs/migration/liveOverload/offline-stt-live-pipeline-mandatory-segmentation.md
 */
export interface TtsLivePipelineOptions extends LiveOfflinePipelineBaseOptions {
  /** Speaker ID for the entire pipeline. Default 0. Overridable per-segment via `segment.meta.sid`. */
  sid?: number;
  /** Speed multiplier. Default 1.0. Overridable per-segment via `segment.meta.speed`. */
  speed?: number;
  /**
   * Runtime language override (`extra["lang"]`). Effective for kokoro and supertonic only.
   * Applied to every segment in the pipeline.
   */
  lang?: string;
  /**
   * Voice cloning configuration. Initialized once per pipeline.
   * Applies to all segments (cloning reference is loaded at pipeline start, not per segment).
   */
  voiceClone?: TtsVoiceClone;
  /**
   * Optional mirror of every committed audio segment that lands on the output `LiveAudioBuffer`.
   * Same constraints as STT's `onSegment` (worker thread, no `onPartial`).
   */
  onSegment?: (segment: SpeechSegment) => void;
}

/**
 * Instance-based batch TTS engine returned by createTTS().
 * Use synthesize() for buffer-to-buffer offline synthesis.
 * For live pipelines, use the LiveText/LiveAudio synthesize overload.
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
  /**
   * Live offline TTS pipeline: reads committed text segments from a `LiveTextBuffer`,
   * synthesizes each via the offline TTS engine, and writes audio chunks to a `LiveAudioBuffer`.
   * Segmentation policy is mandatory (text domain).
   *
   * See: docs/migration/liveOverload/sub-05-tts-live-overload.md
   *
   * @param textIn - Live text buffer (recording state, text domain segmentation applied)
   * @param audioOut - Live audio buffer (recording state, sampleRate must equal model sampleRate)
   * @param options - Pipeline options including mandatory segmentation policy
   * @returns Handle to control and inspect the running pipeline
   */
  synthesize(
    textIn: LiveTextBufferIdSource,
    audioOut: LiveAudioBufferIdSource,
    options: TtsLivePipelineOptions
  ): Promise<TtsPipelineHandle>;
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
