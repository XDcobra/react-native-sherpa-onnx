import type { ModelPathConfig } from '../types';

/**
 * Supported STT model types.
 * Must match ParseSttModelType() in android/.../sherpa-onnx-model-detect-stt.cpp.
 */
export type STTModelType =
  | 'transducer'
  | 'nemo_transducer'
  | 'paraformer'
  | 'nemo_ctc'
  | 'wenet_ctc'
  | 'sense_voice'
  | 'zipformer_ctc'
  | 'ctc'
  | 'whisper'
  | 'funasr_nano'
  | 'fire_red_asr'
  | 'moonshine'
  | 'dolphin'
  | 'canary'
  | 'omnilingual'
  | 'medasr'
  | 'telespeech_ctc'
  | 'auto';

/** Runtime list of supported STT model types (must match ParseSttModelType in native). */
export const STT_MODEL_TYPES: readonly STTModelType[] = [
  'transducer',
  'nemo_transducer',
  'paraformer',
  'nemo_ctc',
  'wenet_ctc',
  'sense_voice',
  'zipformer_ctc',
  'ctc',
  'whisper',
  'funasr_nano',
  'fire_red_asr',
  'moonshine',
  'dolphin',
  'canary',
  'omnilingual',
  'medasr',
  'telespeech_ctc',
  'auto',
] as const;

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
   * - 'zipformer_ctc' | 'ctc': Force detection as Zipformer CTC model
   * - 'paraformer': Force detection as Paraformer model
   * - 'nemo_ctc': Force detection as NeMo CTC model
   * - 'whisper': Force detection as Whisper model
   * - 'wenet_ctc': Force detection as WeNet CTC model
   * - 'sense_voice': Force detection as SenseVoice model
   * - 'funasr_nano': Force detection as FunASR Nano model
   * - 'fire_red_asr': FireRed ASR (encoder/decoder)
   * - 'moonshine': Moonshine (preprocess, encode, uncached_decode, cached_decode)
   * - 'dolphin': Dolphin (single model)
   * - 'canary': Canary (encoder/decoder)
   * - 'omnilingual': Omnilingual CTC (single model)
   * - 'medasr': MedASR CTC (single model)
   * - 'telespeech_ctc': TeleSpeech CTC (single model)
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

  /**
   * Number of threads for inference (Kotlin OfflineModelConfig.numThreads).
   * Default in Kotlin: 1.
   */
  numThreads?: number;

  /**
   * Provider string (e.g. "cpu"). Stored in config only; no special logic on change.
   * Kotlin OfflineModelConfig.provider.
   */
  provider?: string;

  /**
   * Path to rule FSTs (Kotlin OfflineRecognizerConfig.ruleFsts).
   */
  ruleFsts?: string;

  /**
   * Path to rule FARs (Kotlin OfflineRecognizerConfig.ruleFars).
   */
  ruleFars?: string;

  /**
   * Dither for feature extraction (Kotlin FeatureConfig.dither). Default 0.
   */
  dither?: number;
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
  /** Path to rule FSTs. */
  ruleFsts?: string;
  /** Path to rule FARs. */
  ruleFars?: string;
}
