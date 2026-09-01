import type { FileSource } from '../fileio/types';
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
  SkippedSegmentInfo,
} from '../pipeline/offlineOrchestrator';
import type { SegmentationPolicy } from '../segment/engine-types';
import type { SegmentLinkMapRef } from '../segment/segment-link';
import type { LiveOfflinePipelineBaseOptions } from '../livePipeline';
import type { SttPipelineHandle } from './streamingTypes';
import type { TextSegment } from '../segment/segment';

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
  | 'moonshine_v2'
  | 'dolphin'
  | 'canary'
  | 'omnilingual'
  | 'medasr'
  | 'telespeech_ctc'
  | 'tone_ctc'
  | 'auto';

/** Concrete offline STT model types (excludes `'auto'`). */
export type STTConcreteModelType = Exclude<STTModelType, 'auto'>;

/** Shared STT init fields for auto and custom modes. */
export interface STTInitializeOptionsBase {
  debug?: boolean;
  hotwordsFile?: FileSource;
  hotwordsScore?: number;
  modelingUnit?: 'cjkchar' | 'bpe' | 'cjkchar+bpe';
  bpeVocab?: FileSource;
  numThreads?: number;
  provider?: string;
  ruleFsts?: FileSource | readonly FileSource[];
  ruleFars?: FileSource | readonly FileSource[];
  dither?: number;
  modelOptions?: SttModelOptions;
}

/** Automatic model detection from a model directory (default). */
export interface STTAutoInitializeOptions extends STTInitializeOptionsBase {
  initMode?: 'auto';
  modelSource: FileSource;
  preferInt8?: boolean;
  modelType?: STTModelType;
}

/** Explicit per-file model layout; skips native auto-detection. */
export interface STTCustomInitializeOptions<
  T extends STTConcreteModelType = STTConcreteModelType
> extends STTInitializeOptionsBase {
  initMode: 'custom';
  modelType: T;
  customConfig: import('./customConfig').SttCustomConfigByModelType[T];
}

export type STTInitializeOptions =
  | STTAutoInitializeOptions
  | STTCustomInitializeOptions;

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
  'moonshine_v2',
  'dolphin',
  'canary',
  'omnilingual',
  'medasr',
  'telespeech_ctc',
  'tone_ctc',
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
  TEXT_BUFFER_NOT_FOUND: 'TEXT_BUFFER_NOT_FOUND',
  TEXT_ALREADY_POPULATED: 'TEXT_ALREADY_POPULATED',
  STREAM_INSTANCE_NOT_FOUND: 'STT_STREAM_INSTANCE_NOT_FOUND',
  STREAM_NOT_FOUND: 'STT_STREAM_NOT_FOUND',
  STREAM_DECODE_FAILED: 'STT_STREAM_DECODE_FAILED',
  STREAM_FINAL_NOT_AVAILABLE: 'STT_STREAM_FINAL_NOT_AVAILABLE',
  INTERNAL_ERROR: 'STT_INTERNAL_ERROR',
} as const;

export type SttErrorCodeValue =
  (typeof SttErrorCode)[keyof typeof SttErrorCode];

export interface SttSegmentationConfig {
  mode?: 'off' | 'manual' | 'auto';
  policy?: SegmentationPolicy;
}

export interface SttTranscribeOptions {
  segmentation?: SttSegmentationConfig;
  errorRecovery?: ErrorRecoveryStrategy;
  maxRetriesPerSegment?: number;
  retryExhaustedFallback?: 'abort' | 'skip';
  onProgress?: (progress: OrchestrationProgress) => void;
  linkMap?: SegmentLinkMapRef;
  textSkipPlaceholder?: string;
}

export interface SttTranscribeResult {
  status: 'complete' | 'partial' | 'failed';
  totalSegments: number;
  completedSegments: number;
  skippedSegments: SkippedSegmentInfo[];
  failedSegment?: FailedSegmentInfo;
  processingTimeMs: number;
  linkMap?: SegmentLinkMapRef;
}

// ========== Live pipeline options ==========

/**
 * Options for the live-overload of `SttEngine.transcribe(LiveAudio, LiveText, options)`.
 *
 * `segmentation.policy` is REQUIRED — offline weights cannot run in a live pipeline without
 * a segmentation engine driving the segment commit loop.
 * See design note: `docs/migration/liveOverload/offline-stt-live-pipeline-mandatory-segmentation.md`
 */
export interface SttLivePipelineOptions extends LiveOfflinePipelineBaseOptions {
  /**
   * Optional per-segment mirror callback. Fires once per committed text segment with the
   * recognised text. Executes on the worker thread — do not block.
   * No `onPartial` is available; the live-offline path is commit-only by design
   * (see design §7.1).
   */
  onSegment?: (segment: TextSegment) => void;
}

// ========== Engine interfaces ==========

/**
 * Instance-based STT engine returned by createSTT().
 * transcribe() writes results into an OfflineTextBuffer; use TextBuffer getters to read them.
 * A second overload accepts live buffers with mandatory segmentation (live-offline path).
 */
export interface SttEngine {
  readonly instanceId: string;

  /**
   * Batch transcription on offline audio/text buffers.
   * Reads from an offline audio buffer and writes the final transcript to an
   * offline text output buffer.
   */
  transcribe(
    buffer: OfflineAudioBufferRef | OfflineBufferHandle | string,
    textOut: OfflineTextBufferRef | OfflineTextBufferHandle | string,
    options?: SttTranscribeOptions
  ): Promise<SttTranscribeResult>;

  /**
   * Live overload on the offline STT engine.
   * Consumes committed speech segments from a live audio buffer and writes
   * committed transcript segments to a live text output buffer.
   * Segmentation policy is mandatory for this path.
   */
  transcribe(
    audioIn: LiveAudioBufferIdSource,
    textOut: LiveTextBufferIdSource,
    options: SttLivePipelineOptions
  ): Promise<SttPipelineHandle>;

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
