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
  /** Token-level timestamps. Android only; ignored on iOS. */
  enableTokenTimestamps?: boolean;
  /** Segment-level timestamps. Android only; ignored on iOS. */
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

/**
 * Model-specific STT options. Only the block for the actually loaded model type is applied;
 * others are ignored (e.g. whisper options have no effect when a paraformer model is loaded).
 */
export interface SttModelOptions {
  whisper?: SttWhisperModelOptions;
  senseVoice?: SttSenseVoiceModelOptions;
  canary?: SttCanaryModelOptions;
  funasrNano?: SttFunAsrNanoModelOptions;
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
   * See docs/stt.md "When to use which modelingUnit" and sherpa-onnx hotwords docs.
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
   * Dither for feature extraction (Kotlin FeatureConfig.dither). Default 0.
   */
  dither?: number;

  /**
   * Model-specific options. Only options for the loaded model type are applied.
   * E.g. when modelType is 'whisper', only modelOptions.whisper is used.
   */
  modelOptions?: SttModelOptions;
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
 * Instance-based STT engine returned by createSTT().
 * Call destroy() when done to free native resources.
 */
export interface SttEngine {
  readonly instanceId: string;
  transcribeFile(filePath: string): Promise<SttRecognitionResult>;
  transcribeSamples(
    samples: number[],
    sampleRate: number
  ): Promise<SttRecognitionResult>;
  setConfig(options: SttRuntimeConfig): Promise<void>;
  destroy(): Promise<void>;
}

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
