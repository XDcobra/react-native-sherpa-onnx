import type { ModelPathConfig } from '../types';
import type { SubtitleTimingItem } from '../alignment/types';
import type { PcmPlayer } from '../pcm/types';
import type { DetectedModelEntry } from '../types/modelDetect';

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

export type SubtitleMode = 'off' | 'proportional' | 'estimated' | 'accurate';

export type SubtitleGranularity = 'sentence' | 'word' | 'character';

/** Subtitles off, proportional timing, or estimated (synthesis chunks); no alignment model; character not allowed. */
export type SubtitleOptionsProportionalOrEstimated = {
  mode?: 'off' | 'proportional' | 'estimated';
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

export type SubtitleOptions =
  | SubtitleOptionsProportionalOrEstimated
  | SubtitleOptionsAccurate;

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
 * PCM samples are held in a native sink and not transferred to JS by default.
 * Use `getSamples()` to retrieve the PCM data when needed.
 */
export interface GeneratedAudio {
  /**
   * Sample rate of the generated audio in Hz.
   * Common values: 16000, 22050, 44100, 48000
   */
  sampleRate: number;

  /**
   * Number of mono float PCM samples in the generated audio.
   */
  numSamples: number;

  /**
   * Monotonic generation ID (matches native sink).
   * Used internally for stale-detection; may also be useful for debugging.
   */
  generation: number;

  /**
   * Retrieve raw PCM samples from the native sink as Float32Array.
   * Allocates memory in JS — call only when you need raw PCM (e.g. custom playback).
   * Prefer `saveAudioFromGeneration()` for saving to file (avoids JS round-trip).
   *
   * @throws if the generation is stale (a new generateSpeech was called on the same engine)
   * @throws if the engine instance has been destroyed
   */
  getSamples(): Promise<Float32Array>;
}

/**
 * Generated audio with subtitle/timestamp metadata.
 */
export interface GeneratedAudioWithTimestamps extends GeneratedAudio {
  /**
   * Subtitle/timestamp entries.
   */
  subtitles: SubtitleTimingItem[];

  /**
   * Subtitle timing mode (aligned with `react-native-sherpa-onnx/alignment`).
   */
  timingMode: 'off' | 'proportional' | 'estimated' | 'aligned';
}

/**
 * Streaming chunk event payload for TTS generation.
 *
 * PCM data is delivered as `Float32Array` (base64-decoded from native into a
 * typed array in JS; not a zero-copy binary transfer).
 * Internal routing IDs (`instanceId`, `requestId`) are stripped before
 * the chunk reaches public handlers.
 */
export interface TtsStreamChunk {
  /** Mono float PCM samples in [-1, 1]. */
  samples: Float32Array;
  /** Sample rate of the generated audio in Hz. */
  sampleRate: number;
  /** Synthesis progress in [0, 1]. 1.0 on the final chunk. */
  progress: number;
  /** True for the last chunk of a generation. */
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
 * Controller returned by generateSpeechStream().
 * Use cancel() to stop generation, unsubscribe() to remove event listeners.
 */
export interface TtsStreamController {
  /** Cancel the ongoing TTS generation (and destroy the player if playback was active). */
  cancel(): Promise<void>;
  /** Remove event listeners (called automatically on end/error, or manually). */
  unsubscribe(): void;
  /**
   * The player managing native playback for this stream run.
   * Non-null only when streamOptions.playback was true.
   */
  readonly player: PcmPlayer | null;
}

/**
 * Handlers for TTS streaming generation (chunk, end, error).
 */
export interface TtsStreamHandlers {
  onChunk?: (chunk: TtsStreamChunk) => void;
  onEnd?: (event: TtsStreamEnd) => void;
  onError?: (event: TtsStreamError) => void;
}

/** Options controlling stream behavior (playback, chunk emission). */
export interface TtsStreamOptions {
  /**
   * When true, synthesis enqueues PCM into a native player automatically.
   * No writePcmChunk() needed. Default: false.
   */
  playback?: boolean;
  /**
   * When true, onChunk callbacks deliver binary PCM to JS.
   * When false, no chunk events are emitted (only onEnd / onError).
   * Default: true.
   */
  emitChunks?: boolean;
  /**
   * When true, the internally created player (used when playback: true) is automatically
   * destroyed after onEnd fires. Default: true.
   * Set to false to retain the player for deferred destroy() or final draining.
   */
  autoDestroy?: boolean;
}

/** File output target for streaming-to-file generation. */
export type TtsStreamFileOutput = {
  kind: 'file';
  /** Absolute output path. */
  path: string;
};

/** Event payload emitted when stream-to-file finishes. */
export interface TtsStreamFileEnd {
  cancelled: boolean;
  path: string;
  bytesWritten: number;
  sampleRate: number;
}

/** Event payload emitted when stream-to-file fails. */
export interface TtsStreamFileError {
  message: string;
  path?: string;
}

/** Stream-to-file behavior options. */
export type TtsStreamToFileOptions = {
  output: TtsStreamFileOutput;
  /**
   * Output format. v1 supports 'wav'.
   * Reserved for future expansion.
   */
  format?: 'wav';
  /** Keep finalized partial file when cancelled. Default: false. */
  keepPartialOnCancel?: boolean;
  /** Emit normal chunk events while writing to file. Default: false. */
  emitChunks?: boolean;
  /**
   * When true, also play audio through a native player while writing to file.
   * Default: false.
   */
  playback?: boolean;
};

/** Handlers for stream-to-file generation. */
export interface TtsStreamToFileHandlers {
  onChunk?: (chunk: TtsStreamChunk) => void;
  onEnd?: (event: TtsStreamFileEnd) => void;
  onError?: (event: TtsStreamFileError) => void;
}

/** Controller returned by generateSpeechStreamToFile(). */
export interface TtsStreamFileController {
  cancel(): Promise<void>;
  unsubscribe(): void;
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
  /**
   * Play the most recent batch synthesis result through the device speaker.
   * Reads PCM directly from the native sink — no JS memory allocation.
   *
   * @param generation - The generation number from GeneratedAudio.generation.
   *                     Must match the current sink to prevent playing stale audio.
   * @param options - Optional player configuration.
   */
  playFromSink(
    generation: number,
    options?: PlayFromSinkOptions
  ): Promise<TtsBatchPlaybackController>;
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
 * Controller returned by TtsEngine.playFromSink().
 * Provides pause/resume/destroy controls over the batch playback player.
 */
export interface TtsBatchPlaybackController {
  /** The underlying PCM player (feed: 'native'). Use for pause/resume/destroy. */
  readonly player: PcmPlayer;
}

/** Options for TtsEngine.playFromSink(). */
export interface PlayFromSinkOptions {
  /** Sample rate override. If omitted, uses the sink's sample rate. */
  sampleRate?: number;
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

/** Explicit PCM payload for `saveAudioFromPCM()` in `react-native-sherpa-onnx/tts`. */
export type SaveAudioFromPcmInput = {
  samples: number[] | Float32Array;
  sampleRate: number;
};

/**
 * Options for `saveAudioFromGeneration()` / `saveAudioFromPCM()` in `react-native-sherpa-onnx/tts`.
 * `format` defaults to `'wav'`.
 * Non-WAV formats require native FFmpeg; see docs/disable-ffmpeg.md.
 */
export type SaveAudioOptions = {
  /** Same format strings as `convertAudioToFormat` in `react-native-sherpa-onnx/audio` (e.g. `wav`, `mp3`, `flac`, `m4a`, `opus`). */
  format?: string;
  /** Encoder output sample rate hint; `0` uses native defaults. MP3/Opus have allowed values — see audio-conversion.md. */
  outputSampleRateHz?: number;
};
