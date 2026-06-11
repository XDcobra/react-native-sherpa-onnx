import type { FileSource } from '../fileio/types';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type { SeparationDetectModelResult } from '../types/modelDetect';
import type { SpleeterCustomConfig, UvrCustomConfig } from './customConfig';
import type {
  ErrorRecoveryStrategy,
  FailedSegmentInfo,
  OrchestrationProgress,
  SkippedSegmentInfo,
} from '../pipeline/offlineOrchestrator';
import type { SegmentationPolicy } from '../segment/engine-types';
import type { SeparationPipelineHandle } from './streamingTypes';
import type { LiveOfflinePipelineBaseOptions } from '../livePipeline';
import type { SpeechSegment } from '../segment/segment';

export type SeparationModelType = 'spleeter' | 'uvr';

export const SEPARATION_MODEL_TYPES: readonly SeparationModelType[] = [
  'spleeter',
  'uvr',
] as const;

export type SeparationDetectResult = SeparationDetectModelResult;

export type SeparationConcreteModelType = SeparationModelType;

export type SeparationInitOptionsShared = {
  numThreads?: number;
  provider?: string;
  debug?: boolean;
};

export type SeparationAutoInitializeOptions = SeparationInitOptionsShared & {
  initMode?: 'auto';
  modelSource: FileSource;
  modelType?: SeparationModelType | 'auto';
};

export type SeparationCustomInitializeOptions = SeparationInitOptionsShared &
  (
    | {
        initMode: 'custom';
        modelType: 'spleeter';
        customConfig: SpleeterCustomConfig;
      }
    | { initMode: 'custom'; modelType: 'uvr'; customConfig: UvrCustomConfig }
  );

export type SeparationInitializeOptions =
  | SeparationAutoInitializeOptions
  | SeparationCustomInitializeOptions;

export interface SeparateSegmentationConfig {
  /** MVP: only `'off'` (default). `'auto'`/`'manual'` added with orchestrator. */
  mode?: 'off' | 'manual' | 'auto';
  policy?: SegmentationPolicy;
}

export interface SeparateOptions {
  segmentation?: SeparateSegmentationConfig;
  /** Reserved — wired when orchestrator ships. */
  errorRecovery?: ErrorRecoveryStrategy;
  maxRetriesPerSegment?: number;
  retryExhaustedFallback?: 'abort' | 'skip';
  abortSignal?: AbortSignal;
  onProgress?: (progress: OrchestrationProgress) => void;
  overlapSamples?: number;
}

export interface SeparationResult {
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  totalSegments: number;
  completedSegments: number;
  skippedSegments: SkippedSegmentInfo[];
  failedSegment?: FailedSegmentInfo;
  processingTimeMs: number;
}

export type SeparationStemIndex = 0 | 1;

export const SEPARATION_STEM_LABELS: readonly ['vocals', 'accompaniment'] = [
  'vocals',
  'accompaniment',
] as const;

export type SeparationEngineInfo = {
  instanceId: string;
  modelType: SeparationConcreteModelType;
  sampleRate: number;
  numStems: number;
};

export interface SeparationEngine {
  readonly instanceId: string;

  /**
   * Offline batch separation (Enhancement-shaped API).
   * MVP: `segmentation.mode` defaults to `'off'` → single native batch call.
   */
  separate(
    audioIn: OfflineAudioBufferIdSource,
    audioOuts: readonly OfflineAudioBufferIdSource[],
    options?: SeparateOptions
  ): Promise<SeparationResult>;

  /**
   * Live overload — NOT implemented in MVP.
   * Future: template (b), `continuous_frames` only (see live-overload doc §5.1).
   */
  // separate(
  //   audioIn: LiveAudioBufferIdSource,
  //   audioOuts: readonly LiveAudioBufferIdSource[],
  //   options: SeparationLivePipelineOptions
  // ): Promise<SeparationPipelineHandle>;

  getSampleRate(): Promise<number>;
  getNumStems(): Promise<number>;
  destroy(): Promise<void>;
}

/**
 * Live-pipeline options — type stub for future live overload (not exported from index until implemented).
 */
export interface SeparationLivePipelineOptions
  extends LiveOfflinePipelineBaseOptions {
  segmentation: {
    policy: SegmentationPolicy & { evaluator: 'continuous_frames' };
    mode?: 'auto';
  };
  onSegment?: (segment: SpeechSegment) => void;
}

export type { SeparationPipelineHandle };

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type SeparationDetectModelResult,
  type ModelDetectResultBase,
} from '../types/modelDetect';
