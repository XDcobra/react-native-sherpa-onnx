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
 * - 'auto': Auto-detect model type based on files present (default)
 */
export type TTSModelType =
  | 'vits'
  | 'matcha'
  | 'kokoro'
  | 'kitten'
  | 'pocket'
  | 'zipvoice'
  | 'auto';

/** Runtime list of supported TTS model types. */
export const TTS_MODEL_TYPES: readonly TTSModelType[] = [
  'vits',
  'matcha',
  'kokoro',
  'kitten',
  'pocket',
  'zipvoice',
  'auto',
] as const;

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

/**
 * Model-specific TTS options. Only the block for the actually loaded model type is applied;
 * others are ignored (e.g. vits options have no effect when a kokoro model is loaded).
 */
export interface TtsModelOptions {
  vits?: TtsVitsModelOptions;
  matcha?: TtsMatchaModelOptions;
  kokoro?: TtsKokoroModelOptions;
  kitten?: TtsKittenModelOptions;
  pocket?: TtsPocketModelOptions;
}

/**
 * Configuration for TTS initialization.
 */
export interface TTSInitializeOptions {
  /**
   * Path to the model directory.
   * Can be an asset path, file system path, or auto-detection path.
   */
  modelPath: ModelPathConfig;

  /**
   * Model type to use.
   * If not specified or 'auto', the model type will be auto-detected
   * based on the files present in the model directory.
   *
   * @default 'auto'
   */
  modelType?: TTSModelType;

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
   * Model-specific options. Only options for the loaded model type are applied.
   * E.g. when modelType is 'vits', only modelOptions.vits is used.
   */
  modelOptions?: TtsModelOptions;

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
}

/**
 * Options for updating TTS model parameters at runtime.
 * Only the block for the given modelType is applied; flattened to native noiseScale / noiseScaleW / lengthScale.
 */
export interface TtsUpdateOptions {
  /**
   * Model type currently loaded. When omitted or 'auto', the SDK uses the model type from the last
   * successful initializeTTS(). After unloadTTS(), pass modelType explicitly until init is called again.
   */
  modelType?: TTSModelType;

  /**
   * Model-specific options. Only the block for the effective model type is used (e.g. modelOptions.vits when type is 'vits').
   */
  modelOptions?: TtsModelOptions;
}

/**
 * Options for TTS generation. Maps to Kotlin GenerationConfig when reference
 * audio or advanced options are used; otherwise simple sid/speed are used.
 */
export interface TtsGenerationOptions {
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
   * - 1.0 = normal speed
   * - 0.5 = half speed (slower)
   * - 2.0 = double speed (faster)
   *
   * @default 1.0
   */
  speed?: number;

  /**
   * Silence scale (Kotlin GenerationConfig.silenceScale). Used at generate time.
   */
  silenceScale?: number;

  /**
   * Reference audio for voice cloning (Kotlin GenerationConfig).
   * In the Kotlin/RN stack, only Pocket TTS uses this; other model types (vits, matcha, kokoro, kitten) ignore it.
   * Mono float samples in [-1, 1] and sample rate in Hz.
   */
  referenceAudio?: { samples: number[]; sampleRate: number };

  /**
   * Transcript text of the reference audio (Kotlin GenerationConfig.referenceText).
   * Required for Pocket TTS when referenceAudio is provided; ignored by other model types.
   */
  referenceText?: string;

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
}

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
   * True if timestamps are estimated rather than model-provided.
   */
  estimated: boolean;
}

/**
 * Streaming chunk event payload for TTS generation.
 */
export interface TtsStreamChunk {
  /** Instance ID (set by native for multi-instance routing). */
  instanceId?: string;
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
  cancelled: boolean;
}

/**
 * Streaming error event payload.
 */
export interface TtsStreamError {
  /** Instance ID (set by native for multi-instance routing). */
  instanceId?: string;
  message: string;
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
 * Instance-based TTS engine returned by createTTS().
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
  generateSpeechStream(
    text: string,
    options: TtsGenerationOptions | undefined,
    handlers: TtsStreamHandlers
  ): Promise<() => void>;
  cancelSpeechStream(): Promise<void>;
  startPcmPlayer(sampleRate: number, channels: number): Promise<void>;
  writePcmChunk(samples: number[]): Promise<void>;
  stopPcmPlayer(): Promise<void>;
  updateParams(options: TtsUpdateOptions): Promise<{
    success: boolean;
    detectedModels: Array<{ type: string; modelDir: string }>;
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
