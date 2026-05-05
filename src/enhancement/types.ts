import type { FileSource } from '../fileio/types';
import type { EnhancementDetectModelResult } from '../types/modelDetect';
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

export type EnhancementModelType = 'gtcrn' | 'dpdfnet';

export const ENHANCEMENT_MODEL_TYPES: readonly EnhancementModelType[] = [
  'gtcrn',
  'dpdfnet',
] as const;

export interface EnhancementInitializeOptions {
  modelSource: FileSource;
  modelType?: EnhancementModelType | 'auto';
  numThreads?: number;
  provider?: string;
  debug?: boolean;
}

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
  abortSignal?: AbortSignal;
  onProgress?: (progress: OrchestrationProgress) => void;
  overlapSamples?: number;
}

export interface EnhancementResult {
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
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

export interface EnhancementEngine {
  readonly instanceId: string;
  /**
   * Read-only input offline buffer; writes denoised PCM into empty `audioOut`.
   * Both arguments must resolve to offline audio buffer ids (`off_*`).
   * `audioIn` must be populated; `audioOut` must be empty (created via `createEmptyOfflineAudioBuffer`).
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
   */
  enhance(
    audioIn: LiveAudioBufferIdSource,
    audioOut: LiveAudioBufferIdSource,
    options: EnhancementLivePipelineOptions
  ): Promise<EnhancementPipelineHandle>;

  getSampleRate(): Promise<number>;
  destroy(): Promise<void>;
}
