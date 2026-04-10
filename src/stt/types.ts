import type { ModelPathConfig } from '../types';
import type {
  OfflineAudioBufferRef,
  OfflineBufferHandle,
} from '../audiobuffer/types';

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
  | 'qwen3_asr'
  | 'cohere_transcribe'
  | 'fire_red_asr'
  | 'moonshine'
  | 'dolphin'
  | 'canary'
  | 'omnilingual'
  | 'medasr'
  | 'telespeech_ctc'
  | 'auto';

/** Model types that support hotwords (contextual biasing). Transducer and NeMo transducer support hotwords in sherpa-onnx (NeMo: see k2-fsa/sherpa-onnx#3077). */
export const STT_HOTWORDS_MODEL_TYPES: readonly STTModelType[] = [
  'transducer',
  'nemo_transducer',
] as const;

/**
 * Returns true only for model types that support hotwords (transducer, nemo_transducer).
 * Use this to show/hide hotword options in the UI or to validate before init/setSttConfig.
 */
export function sttSupportsHotwords(modelType: STTModelType | string): boolean {
  return modelType === 'transducer' || modelType === 'nemo_transducer';
}

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
  'qwen3_asr',
  'cohere_transcribe',
  'fire_red_asr',
  'moonshine',
  'dolphin',
  'canary',
  'omnilingual',
  'medasr',
  'telespeech_ctc',
  'auto',
] as const;

/** Result of initializeSTT(). decodingMethod is set when init succeeds (e.g. "greedy_search" or "modified_beam_search"; auto-set when hotwords are used). */
export interface SttInitResult {
  success: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
  decodingMethod?: string;
}

// ========== Model-specific options (only applied when that model type is loaded) ==========

/** Options for Whisper models. Applied only when modelType is 'whisper'. */
export interface SttWhisperModelOptions {
  /** Language code (e.g. "en", "de"). Used with multilingual models. Default: "en". */
  language?: string;
  /** "transcribe" or "translate". Default: "transcribe". With "translate", result text is English. */
  task?: 'transcribe' | 'translate';
  /** Padding at end of samples. Kotlin default 1000; C++ default -1. */
  tailPaddings?: number;
  /**
   * Token-level timestamps (cross-attention / DTW). Requires Whisper ONNX models
   * built with attention outputs (see sherpa-onnx).
   */
  enableTokenTimestamps?: boolean;
  /** Segment-level timestamps via Whisper timestamp tokens. */
  enableSegmentTimestamps?: boolean;
}

/** Options for SenseVoice models. Applied only when modelType is 'sense_voice'. */
export interface SttSenseVoiceModelOptions {
  /** Language hint. */
  language?: string;
  /** Inverse text normalization. Default: true (Kotlin), false (C++). */
  useItn?: boolean;
}

/** Options for Canary models. Applied only when modelType is 'canary'. */
export interface SttCanaryModelOptions {
  /** Source language code. Default: "en". */
  srcLang?: string;
  /** Target language code. Default: "en". */
  tgtLang?: string;
  /** Use punctuation. Default: true. */
  usePnc?: boolean;
}

/** Options for FunASR Nano models. Applied only when modelType is 'funasr_nano'. */
export interface SttFunAsrNanoModelOptions {
  /** System prompt. Default: "You are a helpful assistant." */
  systemPrompt?: string;
  /** User prompt prefix. Default: "语音转写：" */
  userPrompt?: string;
  /** Max new tokens. Default: 512. */
  maxNewTokens?: number;
  /** Temperature. Default: 1e-6. */
  temperature?: number;
  /** Top-p. Default: 0.8. */
  topP?: number;
  /** Random seed. Default: 42. */
  seed?: number;
  /** Language hint. */
  language?: string;
  /** Inverse text normalization. Default: true. */
  itn?: boolean;
  /** Hotwords string. */
  hotwords?: string;
}

/** Options for Qwen3 ASR models. Applied only when modelType is 'qwen3_asr'. */
export interface SttQwen3AsrModelOptions {
  /**
   * Optional comma-separated hotword phrases (UTF-8). Applied per decode via native stream option
   * `"hotwords"` — not the same as transducer `hotwordsFile`. Omit when unused.
   */
  hotwords?: string;
  /** Max total sequence length. Default: 512. */
  maxTotalLen?: number;
  /** Max new tokens to generate. Default: 128. */
  maxNewTokens?: number;
  /** Sampling temperature. Default: 1e-6. */
  temperature?: number;
  /** Top-p sampling. Default: 0.8. */
  topP?: number;
  /** Random seed. Default: 42. */
  seed?: number;
}

/** Options for Cohere Transcribe models. Applied only when modelType is 'cohere_transcribe'. */
export interface SttCohereTranscribeModelOptions {
  /** Spoken language code (e.g. en, de, zh). Default: "en". */
  language?: string;
  /** Punctuation. Default: true. */
  usePunct?: boolean;
  /** Inverse text normalization. Default: true. */
  useItn?: boolean;
}

/**
 * Model-specific STT options. Only the block for the actually loaded model type is applied;
 * others are ignored (e.g. whisper options have no effect when a paraformer model is loaded).
 */
export interface SttModelOptions {
  whisper?: SttWhisperModelOptions;
  senseVoice?: SttSenseVoiceModelOptions;
  canary?: SttCanaryModelOptions;
  funasrNano?: SttFunAsrNanoModelOptions;
  qwen3Asr?: SttQwen3AsrModelOptions;
  cohereTranscribe?: SttCohereTranscribeModelOptions;
}

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
   * - 'qwen3_asr': Force detection as Qwen3 ASR
   * - 'cohere_transcribe': Cohere Transcribe (encoder/decoder + tokens.txt)
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
   * Modeling unit for hotwords tokenization (Kotlin OfflineModelConfig.modelingUnit).
   * Only used when hotwords are set and model is transducer/nemo_transducer.
   * Must match how the model was trained: 'bpe' (e.g. English zipformer), 'cjkchar' (e.g. Chinese conformer), 'cjkchar+bpe' (bilingual zh-en).
   * See docs/stt-offline.md "When to use which modelingUnit" and sherpa-onnx hotwords docs.
   */
  modelingUnit?: 'cjkchar' | 'bpe' | 'cjkchar+bpe';

  /**
   * Path to BPE vocabulary file for hotwords (Kotlin OfflineModelConfig.bpeVocab).
   * Required when modelingUnit is 'bpe' or 'cjkchar+bpe'. Sentencepiece .vocab export (bpe.vocab), not the hotwords file.
   */
  bpeVocab?: string;

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
   * Dither for feature extraction (Kotlin `FeatureConfig.dither`). Default: no dither.
   * **Android:** applied natively. **iOS:** ignored — the bundled sherpa-onnx C/CXX API does not
   * expose this field; the native default is used.
   */
  dither?: number;

  /**
   * Model-specific options. Only options for the loaded model type are applied.
   * E.g. when modelType is 'whisper', only modelOptions.whisper is used.
   */
  modelOptions?: SttModelOptions;
}

/**
 * Metadata-only reference to a native STT result (by-reference).
 * Large arrays (tokens, timestamps, durations) stay native until fetched via discrete getters.
 */
export interface SttTranscribeRef {
  success: boolean;
  resultId?: number;
  sampleRate?: number;
  textLength?: number;
  tokenCount?: number;
  timestampCount?: number;
  durationCount?: number;
  hasLang?: boolean;
  hasEmotion?: boolean;
  hasEvent?: boolean;
  error?: string;
}

// ========== STT error codes ==========

export const SttErrorCode = {
  INVALID_ARGUMENT: 'STT_INVALID_ARGUMENT',
  INSTANCE_NOT_FOUND: 'STT_INSTANCE_NOT_FOUND',
  NOT_INITIALIZED: 'STT_NOT_INITIALIZED',
  INIT_FAILED: 'STT_INIT_FAILED',
  MODEL_DETECTION_FAILED: 'STT_MODEL_DETECTION_FAILED',
  MODEL_UNSUPPORTED_HARDWARE: 'STT_MODEL_UNSUPPORTED_HARDWARE',
  CONFIG_FAILED: 'STT_CONFIG_FAILED',
  TRANSCRIBE_FAILED: 'STT_TRANSCRIBE_FAILED',
  BUFFER_NOT_FOUND: 'STT_BUFFER_NOT_FOUND',
  BUFFER_KIND_MISMATCH: 'STT_BUFFER_KIND_MISMATCH',
  BUFFER_EMPTY: 'STT_BUFFER_EMPTY',
  RESULT_EMPTY: 'STT_RESULT_EMPTY',
  RESULT_NOT_FOUND: 'STT_RESULT_NOT_FOUND',
  STALE_RESULT: 'STT_STALE_RESULT',
  SLICE_INVALID: 'STT_SLICE_INVALID',
  SLICE_TOO_LARGE: 'STT_SLICE_TOO_LARGE',
  STREAM_INSTANCE_NOT_FOUND: 'STT_STREAM_INSTANCE_NOT_FOUND',
  STREAM_NOT_FOUND: 'STT_STREAM_NOT_FOUND',
  STREAM_DECODE_FAILED: 'STT_STREAM_DECODE_FAILED',
  STREAM_FINAL_NOT_AVAILABLE: 'STT_STREAM_FINAL_NOT_AVAILABLE',
  INTERNAL_ERROR: 'STT_INTERNAL_ERROR',
} as const;

export type SttErrorCodeValue =
  (typeof SttErrorCode)[keyof typeof SttErrorCode];

// ========== Slice constants ==========

export const STT_DEFAULT_SLICE_COUNT = 1024;
export const STT_MAX_SLICE_COUNT = 16384;

// ========== Engine interfaces ==========

/**
 * Instance-based STT engine returned by createSTT().
 * transcribe() returns a metadata-only ref; use getters for large data.
 */
export interface SttEngine {
  readonly instanceId: string;
  transcribe(
    buffer: OfflineAudioBufferRef | OfflineBufferHandle | string
  ): Promise<SttTranscribeRef>;
  getSttResultText(resultId: number): Promise<string>;
  getSttResultTokens(
    resultId: number,
    start?: number,
    maxCount?: number
  ): Promise<string[]>;
  getSttResultTimestamps(
    resultId: number,
    start?: number,
    maxCount?: number
  ): Promise<number[]>;
  getSttResultDurations(
    resultId: number,
    start?: number,
    maxCount?: number
  ): Promise<number[]>;
  getSttResultLang(resultId: number): Promise<string>;
  getSttResultEmotion(resultId: number): Promise<string>;
  getSttResultEvent(resultId: number): Promise<string>;
  releaseSttResult(): Promise<void>;
  setConfig(options: SttRuntimeConfig): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * Runtime config for the offline recognizer.
 * Only fields that can be updated via setConfig are included.
 */
export interface SttRuntimeConfig {
  decodingMethod?: string;
  maxActivePaths?: number;
  hotwordsFile?: string;
  hotwordsScore?: number;
  blankPenalty?: number;
  ruleFsts?: string;
  ruleFars?: string;
}
