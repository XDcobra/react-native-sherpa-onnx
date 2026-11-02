import type { FileSource } from '../fileio/types';
import type { EnhancementDetectModelResult } from '../types/modelDetect';
import type { QuantizationPreference } from '../download/types';
import type {
  OfflineAudioBufferIdSource,
  LiveAudioBufferIdSource,
} from '../audiobuffer/types';
import type { SpeechSegment } from '../segment/segment';
import type { LiveOfflinePipelineBaseOptions } from '../livePipeline';
import type { EnhancementPipelineHandle } from './streamingTypes';
import type {
  ErrorRecoveryStrategy,
  FailedSegmentInfo,
  OrchestrationProgress,
  SkippedSegmentInfo,
} from '../pipeline/offlineOrchestrator';
import type { SegmentationPolicy } from '../segment/engine-types';

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type EnhancementDetectModelResult,
  type ModelDetectResultBase,
} from '../types/modelDetect';

export type EnhancementConcreteModelType = 'gtcrn' | 'dpdfnet' | 'voxlock';

export type EnhancementModelType = EnhancementConcreteModelType | 'auto';

export const ENHANCEMENT_MODEL_TYPES: readonly EnhancementModelType[] = [
  'gtcrn',
  'dpdfnet',
  'voxlock',
  'auto',
] as const;

export function isEnhancementConcreteModelType(
  value: string | undefined
): value is EnhancementConcreteModelType {
  return value === 'gtcrn' || value === 'dpdfnet' || value === 'voxlock';
}

export function isEnhancementModelType(
  value: string
): value is EnhancementModelType {
  return value === 'auto' || isEnhancementConcreteModelType(value);
}

export function resolveEnhancementEngineModelType(
  options: EnhancementInitializeOptions,
  nativeType?: string
): EnhancementConcreteModelType {
  if (isEnhancementConcreteModelType(options.modelType)) {
    return options.modelType;
  }
  if (isEnhancementConcreteModelType(nativeType)) {
    return nativeType;
  }
  return 'gtcrn';
}

export function voiceSampleFromInitOptions(
  options: EnhancementInitializeOptions
): OfflineAudioBufferIdSource | undefined {
  if (options.modelType !== 'voxlock') {
    return undefined;
  }
  return options.voiceSample;
}

export type EnhancementInitOptionsShared = {
  numThreads?: number;
  provider?: string;
  debug?: boolean;
};

type EnhancementVoiceSampleInitFor<T extends EnhancementConcreteModelType> =
  T extends 'voxlock'
    ? {
        /**
         * Optional VoxLock enroll clip. Applied via `setVoiceSample` after
         * native Create. Omitted keeps auto-enroll from the input. PCM
         * `OfflineAudioBuffer` only — not a file path and not on `customConfig`.
         */
        voiceSample?: OfflineAudioBufferIdSource;
      }
    : { voiceSample?: never };

export type EnhancementAutoInitializeOptionsAuto =
  EnhancementInitOptionsShared & {
    initMode?: 'auto';
    modelSource: FileSource;
    quantization?: QuantizationPreference;
    modelType?: 'auto';
    voiceSample?: never;
  };

export type EnhancementAutoInitializeOptionsGtcrn =
  EnhancementInitOptionsShared & {
    initMode?: 'auto';
    modelSource: FileSource;
    quantization?: QuantizationPreference;
    modelType: 'gtcrn';
    voiceSample?: never;
  };

export type EnhancementAutoInitializeOptionsDpdfnet =
  EnhancementInitOptionsShared & {
    initMode?: 'auto';
    modelSource: FileSource;
    quantization?: QuantizationPreference;
    modelType: 'dpdfnet';
    voiceSample?: never;
  };

export type EnhancementAutoInitializeOptionsVoxlock =
  EnhancementInitOptionsShared &
    EnhancementVoiceSampleInitFor<'voxlock'> & {
      initMode?: 'auto';
      modelSource: FileSource;
      quantization?: QuantizationPreference;
      modelType: 'voxlock';
    };

export type EnhancementAutoInitializeOptions =
  | EnhancementAutoInitializeOptionsAuto
  | EnhancementAutoInitializeOptionsGtcrn
  | EnhancementAutoInitializeOptionsDpdfnet
  | EnhancementAutoInitializeOptionsVoxlock;

export type EnhancementCustomInitializeOptions<
  T extends EnhancementConcreteModelType = EnhancementConcreteModelType
> = {
  [K in T]: EnhancementInitOptionsShared &
    EnhancementVoiceSampleInitFor<K> & {
      initMode: 'custom';
      modelType: K;
      customConfig: import('./customConfig').EnhancementCustomConfigByModelType[K];
    };
}[T];

export type EnhancementInitializeOptions =
  | EnhancementAutoInitializeOptions
  | EnhancementCustomInitializeOptions;

export type EnhancementDetectResult = EnhancementDetectModelResult;

export interface EnhanceSegmentationConfig {
  mode?: 'off' | 'manual' | 'auto';
  policy?: SegmentationPolicy;
}

export interface EnhanceOptions {
  segmentation?: EnhanceSegmentationConfig;
  errorRecovery?: ErrorRecoveryStrategy;
  maxRetriesPerSegment?: number;
  retryExhaustedFallback?: 'abort' | 'skip';
  onProgress?: (progress: OrchestrationProgress) => void;
  overlapSamples?: number;
}

export interface EnhancementResult {
  status: 'complete' | 'partial' | 'failed';
  totalSegments: number;
  completedSegments: number;
  skippedSegments: SkippedSegmentInfo[];
  failedSegment?: FailedSegmentInfo;
  processingTimeMs: number;
}

/**
 * Live-pipeline options for enhancement. Policy evaluator is restricted to
 * `continuous_frames` — see `sub-06-enhancement-live-overload.md`.
 */
export interface EnhancementLivePipelineOptions
  extends LiveOfflinePipelineBaseOptions {
  segmentation: {
    /** Required. Must be a `continuous_frames` policy. */
    policy: SegmentationPolicy & { evaluator: 'continuous_frames' };
    mode?: 'auto';
  };

  /**
   * Optional mirror of every committed audio chunk (per `continuous_frames`
   * checkpoint). Same constraints as STT's `onSegment`.
   */
  onSegment?: (segment: SpeechSegment) => void;
}

type EnhancementEngineCore<F extends EnhancementConcreteModelType> = {
  readonly instanceId: string;
  readonly modelType: F;
  /**
   * Read-only input offline buffer; writes denoised PCM into empty `audioOut`.
   * Both arguments must resolve to offline audio buffer ids (`off_*`).
   * `audioIn` must be populated; `audioOut` must be empty (created via `createEmptyOfflineAudioBuffer`).
   * @throws {Error} `ENHANCEMENT_ERROR` — native enhance failed.
   * @throws {Error} `ENHANCEMENT_BUFFER_NOT_FOUND` — input or output buffer is unknown.
   * @throws {Error} `ENHANCEMENT_BUFFER_KIND_MISMATCH` — buffer is not the required offline kind.
   * @throws {Error} `ENHANCEMENT_BUFFER_EMPTY` — input audio has no samples.
   * @throws {Error} `ENHANCEMENT_OUTPUT_NOT_EMPTY` — `audioOut` already has samples.
   * @throws {Error} `OFFLINE_OOM` — native ran out of memory.
   */
  enhance(
    audioIn: OfflineAudioBufferIdSource,
    audioOut: OfflineAudioBufferIdSource,
    options?: EnhanceOptions
  ): Promise<EnhancementResult>;

  /**
   * Live overload on the offline enhancement engine.
   * Consumes committed speech chunks from a live input buffer and writes
   * denoised committed chunks to a live audio output buffer.
   * Restricted to `continuous_frames` segmentation policies.
   * @throws {Error} `ENHANCE_INVALID_ARGUMENT` — live/offline overload mismatch.
   * @throws {Error} `ENHANCEMENT_ERROR` — live segment buffer missing or native pipeline failed.
   * @throws {Error} `LIVE_OFFLINE_SEGMENTATION_REQUIRED` — live path requires a segmentation policy.
   * @throws {Error} `ENHANCEMENT_PIPELINE_BUFFER_NOT_FOUND` — live audio buffer is unknown.
   */
  enhance(
    audioIn: LiveAudioBufferIdSource,
    audioOut: LiveAudioBufferIdSource,
    options: EnhancementLivePipelineOptions
  ): Promise<EnhancementPipelineHandle>;

  getSampleRate(): Promise<number>;
  destroy(): Promise<void>;
};

export type EnhancementEngineOf<F extends EnhancementConcreteModelType> =
  EnhancementEngineCore<F> &
    (F extends 'voxlock'
      ? {
          /**
           * Lock a VoxLock engine to a specific voice from an offline PCM buffer.
           * Resamples to the model rate and keeps the loudest 3 seconds in the first
           * 30 seconds. Create still auto-enrolls from the input until this is called.
           * Also available at create as `voiceSample`; `customConfig` stays model files only.
           * @throws {Error} `ENHANCEMENT_INVALID_ARGUMENT` — clip shorter than 3s after resample.
           * @throws {Error} `ENHANCEMENT_BUFFER_NOT_FOUND` — buffer is unknown.
           * @throws {Error} `ENHANCEMENT_BUFFER_KIND_MISMATCH` — buffer is not `off_*`.
           * @throws {Error} `ENHANCEMENT_BUFFER_EMPTY` — buffer has no samples.
           */
          setVoiceSample(buffer: OfflineAudioBufferIdSource): Promise<void>;
        }
      : { setVoiceSample?: never });

/** A real union so `engine.modelType === 'voxlock'` narrows. */
export type EnhancementEngine = {
  [F in EnhancementConcreteModelType]: EnhancementEngineOf<F>;
}[EnhancementConcreteModelType];

/** Maps `createEnhancement({ modelType })` onto a family-typed engine. */
export type EnhancementEngineForInit<O extends EnhancementInitializeOptions> =
  O extends { modelType: infer T }
    ? T extends EnhancementConcreteModelType
      ? EnhancementEngineOf<T>
      : EnhancementEngine
    : EnhancementEngine;
