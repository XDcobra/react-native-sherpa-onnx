import type { ModelPathConfig } from '../types';

/**
 * Supported STT model types.
 */
export type STTModelType =
  | 'transducer'
  | 'zipformer'
  | 'paraformer'
  | 'nemo_ctc'
  | 'whisper'
  | 'wenet_ctc'
  | 'sense_voice'
  | 'funasr_nano'
  | 'auto';

/**
 * STT-specific initialization options
 */
export interface STTInitializeOptions {
  /**
   * Model directory path configuration
   */
  modelPath: ModelPathConfig;

  /**
   * Model quantization preference
   * - true: Prefer int8 quantized models (model.int8.onnx) - smaller, faster
   * - false: Prefer regular models (model.onnx) - higher accuracy
   * - undefined: Try int8 first, then fall back to regular (default behavior)
   */
  preferInt8?: boolean;

  /**
   * Explicit model type specification for STT models
   * - 'transducer': Force detection as Transducer model
   * - 'zipformer': Force detection as Zipformer (streaming) model
   * - 'paraformer': Force detection as Paraformer model
   * - 'nemo_ctc': Force detection as NeMo CTC model
   * - 'whisper': Force detection as Whisper model
   * - 'wenet_ctc': Force detection as WeNet CTC model
   * - 'sense_voice': Force detection as SenseVoice model
   * - 'funasr_nano': Force detection as FunASR Nano model
   * - 'auto': Automatic detection based on files (default)
   */
  modelType?: STTModelType;

  /**
   * Enable debug logging in native layer and sherpa-onnx (config.model_config.debug).
   * When true, wrapper and JNI emit verbose logs (config dumps, file checks, init/transcribe flow).
   * Default: false.
   */
  debug?: boolean;

  /**
   * Path to hotwords file for keyword boosting (Kotlin OfflineRecognizerConfig.hotwordsFile).
   */
  hotwordsFile?: string;

  /**
   * Hotwords score/weight (Kotlin OfflineRecognizerConfig.hotwordsScore).
   * Default in Kotlin: 1.5.
   */
  hotwordsScore?: number;
}

/**
 * Full recognition result from offline STT (maps to Kotlin OfflineRecognizerResult).
 */
export interface SttRecognitionResult {
  /** Transcribed text. */
  text: string;
  /** Token strings. */
  tokens: string[];
  /** Timestamps per token (model-dependent). */
  timestamps: number[];
  /** Detected or specified language (model-dependent). */
  lang: string;
  /** Emotion label (model-dependent, e.g. SenseVoice). */
  emotion: string;
  /** Event label (model-dependent). */
  event: string;
  /** Durations (valid for TDT models). */
  durations: number[];
}

/**
 * @deprecated Use SttRecognitionResult. Kept as alias for compatibility.
 */
export type TranscriptionResult = SttRecognitionResult;

/**
 * Runtime config for the offline recognizer (Kotlin OfflineRecognizerConfig).
 * Only fields that can be updated via setConfig are included.
 */
export interface SttRuntimeConfig {
  /** Decoding method (e.g. greedy_search). */
  decodingMethod?: string;
  /** Max active paths (beam search). */
  maxActivePaths?: number;
  /** Path to hotwords file. */
  hotwordsFile?: string;
  /** Hotwords score. */
  hotwordsScore?: number;
  /** Blank penalty. */
  blankPenalty?: number;
}
