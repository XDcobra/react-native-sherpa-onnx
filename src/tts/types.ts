import type { ModelPathConfig } from '../types';

/**
 * Supported TTS model types.
 *
 * - 'vits': VITS models (includes Piper, Coqui, MeloTTS, MMS variants)
 * - 'matcha': Matcha models (acoustic model + vocoder)
 * - 'kokoro': Kokoro models (multi-speaker, multi-language)
 * - 'kitten': KittenTTS models (lightweight, multi-speaker)
 * - 'zipvoice': Zipvoice models (voice cloning capable)
 * - 'auto': Auto-detect model type based on files present (default)
 */
export type TTSModelType =
  | 'vits'
  | 'matcha'
  | 'kokoro'
  | 'kitten'
  | 'zipvoice'
  | 'auto';

/**
 * Configuration for TTS initialization.
 */
export interface TTSInitializeOptions {
  /**
   * Path to the model directory.
   * Can be an asset path, file system path, or auto-detection path.
   */
  modelPath: ModelPathConfig | string;

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
}

/**
 * Options for speech synthesis.
 */
export interface SynthesisOptions {
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
