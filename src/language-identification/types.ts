import type { FileSource } from '../fileio/types';
import type { QuantizationPreference } from '../download/types';
import type { LanguageIdDetectModelResult } from '../types/modelDetect';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type { LanguageIdCustomConfig } from './customConfig';

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type LanguageIdDetectModelResult,
  type ModelDetectResultBase,
} from '../types/modelDetect';

export type LanguageIdModelType = 'whisper';

export const LANGUAGE_ID_MODEL_TYPES: readonly LanguageIdModelType[] = [
  'whisper',
] as const;

export type LanguageIdConcreteModelType = LanguageIdModelType;

export type LanguageIdDetectResult = LanguageIdDetectModelResult;

export type LanguageIdDetectOptions = {
  modelType?: LanguageIdModelType | 'auto';
  assetName?: string;
  quantization?: QuantizationPreference;
};

export const LanguageIdErrorCode = {
  NOT_INITIALIZED: 'LANGUAGE_ID_NOT_INITIALIZED',
  ALREADY_INITIALIZED: 'LANGUAGE_ID_ALREADY_INITIALIZED',
  INVALID_ARGUMENT: 'LANGUAGE_ID_INVALID_ARGUMENT',
  BUFFER_NOT_FOUND: 'LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND',
  BUFFER_EMPTY: 'LANGUAGE_ID_AUDIO_BUFFER_EMPTY',
  INIT_FAILED: 'LANGUAGE_ID_INIT_ERROR',
  IDENTIFY_FAILED: 'LANGUAGE_ID_IDENTIFY_FAILED',
  DESTROYED: 'LANGUAGE_ID_DESTROYED',
} as const;

export type LanguageIdErrorCode =
  (typeof LanguageIdErrorCode)[keyof typeof LanguageIdErrorCode];

export interface LanguageIdentificationInitializeOptions {
  /** Model directory or archive FileSource (Whisper multilingual model). */
  modelSource?: FileSource;
  /** Explicit custom model paths for encoder and decoder. */
  customConfig?: LanguageIdCustomConfig;
  /** Quantization preference ('auto' | 'int8' | 'fp16' | 'fp32'). Defaults to 'auto'. */
  quantization?: QuantizationPreference;
  /** Number of CPU inference threads. Defaults to 1. */
  numThreads?: number;
  /** Execution provider ('cpu'). Defaults to 'cpu'. */
  provider?: string;
  /** Number of tail padding frames for Whisper (defaults to upstream default). */
  tailPaddings?: number;
  /** Enable verbose native logging. */
  debug?: boolean;
}

/** Result for single-chunk / oneshot offline evaluation (<= 30s). */
export interface LanguageIdentificationResult {
  /** Predicted ISO 639 language code, e.g. 'en', 'de', 'fr', 'zh'. */
  lang: string;
  /** Audio duration in seconds. */
  audioDuration: number;
  /** Inference processing duration in milliseconds. */
  elapsedMs: number;
}

export interface LanguageIdentificationEngine {
  readonly instanceId: string;

  /**
   * Mode 1: Offline Oneshot (<= 30s)
   * Evaluates audio buffer directly in a single pass.
   */
  identify(
    audio: OfflineAudioBufferIdSource
  ): Promise<LanguageIdentificationResult>;

  /** Release native resources. */
  destroy(): Promise<void>;
}
