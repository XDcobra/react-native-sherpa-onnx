import type { ModelPathConfig } from '../types';

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

/** How native TTS detection chose the model kind (mirrors C++ TtsDetectionSource). */
export const TTS_DETECTION_SOURCES = [
  'fileListing',
  'dirName',
  'fallbackOrder',
  'explicitModelType',
  'nameOnly',
] as const;

export type TtsDetectionSource = (typeof TTS_DETECTION_SOURCES)[number];

export function isTtsDetectionSource(s: string): s is TtsDetectionSource {
  return (TTS_DETECTION_SOURCES as readonly string[]).includes(s);
}

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
  modelPath: ModelPathConfig;

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

export type SubtitleMode = 'off' | 'fast' | 'accurate';

export type SubtitleGranularity = 'sentence' | 'word' | 'character';

/** Subtitles off, fast estimation, or defaults: no alignment model; character granularity not allowed. */
export type SubtitleOptionsFast = {
  mode?: 'off' | 'fast';
  granularity?: 'sentence' | 'word';
  alignmentModelPath?: never;
};

/** Forced alignment: alignment ONNX path required; character granularity allowed. */
export type SubtitleOptionsAccurate = {
  mode: 'accurate';
  /** Absolute path to alignment ONNX (required). */
  alignmentModelPath: string;
  granularity?: 'sentence' | 'word' | 'character';
};

export type SubtitleOptions = SubtitleOptionsFast | SubtitleOptionsAccurate;

/** Mono float samples in [-1, 1] for Zipvoice / Pocket voice cloning. */
export type TtsReferenceAudio = {
  samples: number[];
  sampleRate: number;
};

/** Zipvoice cloning: prompt text is required for native. */
export type TtsVoiceCloneZipvoice = {
  kind: 'zipvoice';
  referenceAudio: TtsReferenceAudio;
  referenceText: string;
};

/** Pocket cloning: reference audio required; transcript optional (not read natively). */
export type TtsVoiceClonePocket = {
  kind: 'pocket';
  referenceAudio: TtsReferenceAudio;
  referenceText?: string;
};

export type TtsVoiceClone = TtsVoiceCloneZipvoice | TtsVoiceClonePocket;

type TtsGenerationBase = {
  /**
   * Speaker ID for multi-speaker models.
   * For single-speaker models, this is ignored.
   *
   * Use `getNumSpeakers()` to check how many speakers are available.
   *
   * @default 0
   */
  sid?: number;

  /**
   * Speech speed multiplier.
   *
   * @default 1.0
   */
  speed?: number;

  /**
   * Silence scale (Kotlin GenerationConfig.silenceScale). Used at generate time.
   */
  silenceScale?: number;

  /**
   * Number of steps, e.g. flow-matching steps (Kotlin GenerationConfig.numSteps).
   * Used by models such as Pocket.
   */
  numSteps?: number;

  /**
   * Extra options as key-value pairs (Kotlin GenerationConfig.extra).
   * Model-specific (e.g. temperature, chunk_size for Pocket).
   */
  extra?: Record<string, string>;

  /**
   * Subtitle/timestamp generation options.
   */
  subtitles?: SubtitleOptions;
};

/**
 * Options for TTS generation. Use `voiceClone` for Zipvoice/Pocket reference audio (not top-level reference fields).
 */
export type TtsGenerationOptions = TtsGenerationBase &
  ({ voiceClone?: undefined } | { voiceClone: TtsVoiceClone });

/**
 * Generated audio data from TTS synthesis.
 *
 * The samples are normalized float values in the range [-1.0, 1.0].
 * To save as a WAV file or play the audio, you'll need to convert
 * these samples to the appropriate format for your use case.
 */
export interface GeneratedAudio {
  /**
   * Audio samples as an array of float values in range [-1.0, 1.0].
   * This is raw PCM audio data.
   */
  samples: number[];

  /**
   * Sample rate of the generated audio in Hz.
   * Common values: 16000, 22050, 44100, 48000
   */
  sampleRate: number;
}

/**
 * Subtitle/timestamp item for synthesized speech.
 */
export interface TtsSubtitleItem {
  /**
   * Text token for this time range.
   */
  text: string;

  /**
   * Start time in seconds.
   */
  start: number;

  /**
   * End time in seconds.
   */
  end: number;
}

/**
 * Generated audio with subtitle/timestamp metadata.
 */
export interface GeneratedAudioWithTimestamps extends GeneratedAudio {
  /**
   * Subtitle/timestamp entries.
   */
  subtitles: TtsSubtitleItem[];

  /**
   * Subtitle timing mode.
   *
   * - 'off': No subtitle timing requested/generated
   * - 'estimated': Fast mode estimation
   * - 'aligned': Accurate forced alignment mode
   */
  timingMode: 'off' | 'estimated' | 'aligned';
}

export type SubtitleFromAudioOptionsFast = {
  mode: 'fast';
  granularity?: 'sentence' | 'word';
  language?: string;
  alignmentModelPath?: never;
};

export type SubtitleFromAudioOptionsAccurate = {
  mode: 'accurate';
  /** Required for CTC forced alignment. */
  alignmentModelPath: string;
  granularity?: SubtitleGranularity;
  language?: string;
};

export type SubtitleFromAudioOptions =
  | SubtitleFromAudioOptionsFast
  | SubtitleFromAudioOptionsAccurate;

export interface SubtitleResult {
  subtitles: TtsSubtitleItem[];
  timingMode: 'estimated' | 'aligned';
}

/** One detected TTS stack under a model directory (native may return unknown `type` strings). */
export type TtsDetectedModelEntry = {
  type: TTSModelType | string;
  modelDir: string;
};

/**
 * Streaming chunk event payload for TTS generation.
 */
export interface TtsStreamChunk {
  /** Instance ID (set by native for multi-instance routing). */
  instanceId?: string;
  /** Request ID for this generation (distinguishes concurrent streams on same instance). */
  requestId?: string;
  samples: number[];
  sampleRate: number;
  progress: number;
  isFinal: boolean;
}

/**
 * Streaming end event payload.
 */
export interface TtsStreamEnd {
  /** Instance ID (set by native for multi-instance routing). */
  instanceId?: string;
  /** Request ID for this generation. */
  requestId?: string;
  cancelled: boolean;
}

/**
 * Streaming error event payload.
 */
export interface TtsStreamError {
  /** Instance ID (set by native for multi-instance routing). */
  instanceId?: string;
  /** Request ID for this generation. */
  requestId?: string;
  message: string;
}

/**
 * Controller returned by generateSpeechStream().
 * Use cancel() to stop generation, unsubscribe() to remove event listeners.
 */
export interface TtsStreamController {
  /** Cancel the ongoing TTS generation. */
  cancel(): Promise<void>;
  /** Remove event listeners (called automatically on end/error, or manually). */
  unsubscribe(): void;
}

/**
 * Handlers for TTS streaming generation (chunk, end, error).
 */
export interface TtsStreamHandlers {
  onChunk?: (chunk: TtsStreamChunk) => void;
  onEnd?: (event: TtsStreamEnd) => void;
  onError?: (event: TtsStreamError) => void;
}

/**
 * Instance-based batch TTS engine returned by createTTS().
 * Use for one-shot synthesis (generateSpeech, generateSpeechWithTimestamps).
 * For streaming, use createStreamingTTS() and StreamingTtsEngine instead.
 * Call destroy() when done to free native resources.
 */
export interface TtsEngine {
  readonly instanceId: string;
  generateSpeech(
    text: string,
    options?: TtsGenerationOptions
  ): Promise<GeneratedAudio>;
  generateSpeechWithTimestamps(
    text: string,
    options?: TtsGenerationOptions
  ): Promise<GeneratedAudioWithTimestamps>;
  updateParams(options: TtsUpdateOptions): Promise<{
    success: boolean;
    detectedModels: TtsDetectedModelEntry[];
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

/**
 * Options for `saveAudio()` in `react-native-sherpa-onnx/tts`. `format` defaults to `'wav'`.
 * Non-WAV formats require native FFmpeg; see docs/disable-ffmpeg.md.
 */
export type SaveAudioOptions = {
  /** Same format strings as `convertAudioToFormat` in `react-native-sherpa-onnx/audio` (e.g. `wav`, `mp3`, `flac`, `m4a`, `opus`). */
  format?: string;
  /** Encoder output sample rate hint; `0` uses native defaults. MP3/Opus have allowed values — see audio-conversion.md. */
  outputSampleRateHz?: number;
};
