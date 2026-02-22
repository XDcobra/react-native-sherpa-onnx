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
   * Noise scale for VITS/Matcha models.
   *
   * If omitted, the model default (or model.json) is used.
   */
  noiseScale?: number;

  /**
   * Noise scale W for VITS models.
   *
   * If omitted, the model default (or model.json) is used.
   */
  noiseScaleW?: number;

  /**
   * Length scale for VITS/Matcha/Kokoro/Kitten models.
   *
   * If omitted, the model default (or model.json) is used.
   */
  lengthScale?: number;

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
 * Options for updating TTS model parameters.
 */
export interface TtsUpdateOptions {
  /**
   * Noise scale for VITS/Matcha models.
   */
  noiseScale?: number | null;

  /**
   * Noise scale W for VITS models.
   */
  noiseScaleW?: number | null;

  /**
   * Length scale for VITS/Matcha/Kokoro/Kitten models.
   */
  lengthScale?: number | null;
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
   * Silence scale (Kotlin GenerationConfig). Model-dependent.
   */
  silenceScale?: number;

  /**
   * Reference audio for voice cloning (Zipvoice or Kotlin generateWithConfig).
   * Mono float samples in [-1, 1] and sample rate in Hz.
   */
  referenceAudio?: { samples: number[]; sampleRate: number };

  /**
   * Transcript text of the reference audio. Required for voice cloning when
   * referenceAudio is provided.
   */
  referenceText?: string;

  /**
   * Number of steps (e.g. flow-matching steps). Model-dependent.
   */
  numSteps?: number;

  /**
   * Extra options as key-value pairs (Kotlin GenerationConfig.extra).
   * Model-specific (e.g. temperature, chunk_size for Pocket).
   */
  extra?: Record<string, string>;
}

/**
 * @deprecated Use TtsGenerationOptions. Kept as alias for compatibility.
 */
export type SynthesisOptions = TtsGenerationOptions;

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
  samples: number[];
  sampleRate: number;
  progress: number;
  isFinal: boolean;
}

/**
 * Streaming end event payload.
 */
export interface TtsStreamEnd {
  cancelled: boolean;
}

/**
 * Streaming error event payload.
 */
export interface TtsStreamError {
  message: string;
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
