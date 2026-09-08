import type { FileSource } from '../fileio/types';
import type { QuantizationPreference } from '../download/types';
import type { LanguageIdDetectModelResult } from '../types/modelDetect';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type { OfflineSegmentBufferIdSource } from '../segmentbuffer/types';
import type { SegmentationPolicy } from '../segment/engine-types';
import type { OrchestrationProgress } from '../pipeline/offlineOrchestrator';
import type { LanguageIdCustomConfig } from './customConfig';

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type LanguageIdDetectModelResult,
  type ModelDetectResultBase,
} from '../types/modelDetect';

export type { OrchestrationProgress };

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

export const DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY: SegmentationPolicy = {
  evaluator: 'speech_energy_silence',
  silenceThresholdMs: 500,
  energyThresholdDb: -40,
  minSegmentMs: 1500,
  maxSegmentMs: 25000,
  hangoverMs: 300,
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

/** A single language switch event along a speech timeline. */
export interface LanguageSwitchEntry {
  /** Timestamp in seconds where the new language began. */
  timestamp: number;
  /** Previous language code (or null if first segment). */
  from: string | null;
  /** New language code. */
  to: string;
  /** Index of the segment where the transition occurred. */
  segmentIndex: number;
}

/** One detected speech segment with language information. */
export interface LanguageIdSegmentEntry {
  segmentIndex: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  lang: string;
}

/** Event fired whenever speech transitions from one language to another. */
export interface LanguageChangedEvent {
  previousLang: string | null;
  currentLang: string;
  timestamp: number;
  segmentIndex: number;
}

/** Event fired after each speech segment is evaluated. */
export interface LanguageIdSegmentEvent {
  segmentIndex: number;
  totalSegments?: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  lang: string;
}

/** Detailed result for long-form offline audio with code-switching analysis. */
export interface SegmentedLanguageIdentificationResult {
  /** Dominant language across all speech (duration-weighted). */
  dominantLanguage: string;
  /** Duration-weighted distribution of languages (fractions summing to 1.0, e.g. { en: 0.65, de: 0.35 }). */
  distribution: Record<string, number>;
  /** Chronological list of language switches detected across the audio. */
  switches: LanguageSwitchEntry[];
  /** Detailed segment-by-segment language timeline. */
  segments: LanguageIdSegmentEntry[];
  totalSegments: number;
  processingTimeMs: number;
}

export interface LanguageIdentificationOptions {
  /** Segmentation policy for long-form audio. If omitted or 'off', runs oneshot (<= 30s). */
  segmentation?: {
    mode?: 'off' | 'auto';
    policy?: SegmentationPolicy;
  };
  /** Progress callback during multi-segment processing. */
  onProgress?: (progress: OrchestrationProgress) => void;
  /** Fired for every evaluated speech segment. */
  onSegment?: (event: LanguageIdSegmentEvent) => void;
  /** Fired specifically when a language switch is detected between segments. */
  onLanguageChanged?: (event: LanguageChangedEvent) => void;
  /** Optional target OfflineSegmentBuffer to populate with LanguageIdSpeechSegmentPayload. */
  targetSegmentBuffer?: OfflineSegmentBufferIdSource;
}

/** Fired after a speech span is evaluated and staged during `labelOfflineSegments`. */
export interface LanguageIdLabeledSegmentEvent {
  segmentIndex: number;
  totalSegments: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  lang: string;
}

/** Options for `labelOfflineSegments`. */
export interface LanguageIdLabelOptions {
  onProgress?: (progress: OrchestrationProgress) => void;
  onLabeled?: (event: LanguageIdLabeledSegmentEvent) => void;
}

/** Result from `labelOfflineSegments`. */
export interface LabelOfflineSegmentsResult {
  labeledCount: number;
  dominantLanguage: string;
  distribution: Record<string, number>;
  switches: LanguageSwitchEntry[];
}

export interface LanguageIdentificationEngine {
  readonly instanceId: string;

  /**
   * Mode 1: Offline Oneshot (<= 30s)
   * Evaluates audio buffer directly in a single pass.
   */
  identify(
    audio: OfflineAudioBufferIdSource,
    options?: LanguageIdentificationOptions & {
      segmentation?: { mode?: 'off' };
    }
  ): Promise<LanguageIdentificationResult>;

  /**
   * Mode 2: Offline Segmented (Long-form Audio & Code-Switching)
   * Slices long audio via segmentation policy, evaluates each speech span,
   * compiles code-switching timeline and duration-weighted distribution.
   */
  identify(
    audio: OfflineAudioBufferIdSource,
    options: LanguageIdentificationOptions & {
      segmentation: { mode: 'auto'; policy?: SegmentationPolicy };
    }
  ): Promise<SegmentedLanguageIdentificationResult>;

  /**
   * General signature for identify.
   */
  identify(
    audio: OfflineAudioBufferIdSource,
    options?: LanguageIdentificationOptions
  ): Promise<
    LanguageIdentificationResult | SegmentedLanguageIdentificationResult
  >;

  /**
   * Label existing speech segments in an OfflineSegmentBuffer with LanguageIdSpeechSegmentPayload.
   */
  labelOfflineSegments(
    audioIn: OfflineAudioBufferIdSource,
    segmentsIn: OfflineSegmentBufferIdSource,
    segmentsOut: OfflineSegmentBufferIdSource,
    options?: LanguageIdLabelOptions
  ): Promise<LabelOfflineSegmentsResult>;

  /** Release native resources. */
  destroy(): Promise<void>;
}
