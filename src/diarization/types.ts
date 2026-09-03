import type { FileSource } from '../fileio/types';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type {
  OfflineSegmentBufferIdSource,
  OfflineSegmentBufferRef,
} from '../segmentbuffer/types';
import type { OrchestrationProgress } from '../pipeline/offlineOrchestrator';
import type { DiarizationDetectModelResult } from '../types/modelDetect';

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type DiarizationDetectModelResult,
  type ModelDetectResultBase,
} from '../types/modelDetect';

export type DiarizationModelKind = 'pyannote' | 'reverb';

export const DIARIZATION_MODEL_KINDS: readonly DiarizationModelKind[] = [
  'pyannote',
  'reverb',
] as const;

export type DiarizationDetectResult = DiarizationDetectModelResult;

export const DiarizationErrorCode = {
  INVALID_ARGUMENT: 'DIARIZATION_INVALID_ARGUMENT',
  INIT_ERROR: 'DIARIZATION_INIT_ERROR',
  NOT_INITIALIZED: 'DIARIZATION_NOT_INITIALIZED',
  CANCELLED: 'DIARIZATION_CANCELLED',
  BUFFER_NOT_FOUND: 'DIARIZATION_BUFFER_NOT_FOUND',
} as const;

export interface DiarizationSegmentationOptions {
  modelSource: FileSource;
  /** Hop as fraction of window; 0 or omitted → 0.1 */
  windowShiftRatio?: number;
}

export interface DiarizationEmbeddingOptions {
  modelSource: FileSource;
}

export interface DiarizationClusteringOptions {
  /** When > 0, threshold is ignored. */
  numClusters?: number;
  /** Cosine-dissimilarity threshold when numClusters is unset/≤0. Default 0.5 */
  threshold?: number;
}

export interface DiarizationInitializeOptions {
  segmentation: DiarizationSegmentationOptions;
  embedding: DiarizationEmbeddingOptions;
  clustering?: DiarizationClusteringOptions;
  minDurationOn?: number;
  minDurationOff?: number;
  numThreads?: number;
  provider?: string;
  debug?: boolean;
}

export interface DiarizeOptions {
  onProgress?: (progress: OrchestrationProgress) => void;
  signal?: AbortSignal;
  includeOverlap?: boolean;
}

export interface DiarizeResult {
  status: 'complete' | 'cancelled';
  numSpeakers: number;
  segmentCount: number;
  sampleRate: number;
  processingTimeMs: number;
  speakersPerFrame?: number[];
}

export interface DiarizationReclusterOptions {
  numClusters?: number;
  threshold?: number;
}

export interface DiarizationClusterEmbedding {
  speaker: number;
  embedding: Float32Array;
}

export interface DiarizationEngine {
  readonly instanceId: string;
  readonly sampleRate: number;
  diarize(
    audioIn: OfflineAudioBufferIdSource,
    segmentOut: OfflineSegmentBufferIdSource | OfflineSegmentBufferRef,
    options?: DiarizeOptions
  ): Promise<DiarizeResult>;
  recluster(options?: DiarizationReclusterOptions): Promise<DiarizeResult>;
  getClusterEmbeddings(): Promise<DiarizationClusterEmbedding[]>;
  destroy(): Promise<void>;
}
