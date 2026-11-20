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

export type DiarizationModelKind = 'pyannote' | 'reverb' | 'sortformer';

export const DIARIZATION_MODEL_KINDS: readonly DiarizationModelKind[] = [
  'pyannote',
  'reverb',
  'sortformer',
] as const;

export type DiarizationConcreteModelType = DiarizationModelKind;

export type DiarizationDetectResult = DiarizationDetectModelResult;

export const DiarizationErrorCode = {
  INVALID_ARGUMENT: 'DIARIZATION_INVALID_ARGUMENT',
  INIT_ERROR: 'DIARIZATION_INIT_ERROR',
  NOT_INITIALIZED: 'DIARIZATION_NOT_INITIALIZED',
  CANCELLED: 'DIARIZATION_CANCELLED',
  BUFFER_NOT_FOUND: 'DIARIZATION_BUFFER_NOT_FOUND',
} as const;

import type { QuantizationPreference } from '../download/types';

export interface DiarizationSegmentationOptions {
  modelSource: FileSource;
  quantization?: QuantizationPreference;
  /** Hop as fraction of window; 0 or omitted → 0.1 */
  windowShiftRatio?: number;
}

export interface DiarizationEmbeddingOptions {
  modelSource: FileSource;
  quantization?: QuantizationPreference;
}

export interface DiarizationClusteringOptions {
  /** When > 0, threshold is ignored. */
  numClusters?: number;
  /** Cosine-dissimilarity threshold when numClusters is unset/≤0. Default 0.5 */
  threshold?: number;
  /**
   * When true, each segment includes silhouette-based `confidence` in [-1, 1].
   * Default **false** (upstream `compute_confidence` parity).
   */
  computeConfidence?: boolean;
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

/** Stage of an offline diarize run reported in {@link DiarizationProgress}. */
export type DiarizationProgressPhase =
  | 'segmentation'
  | 'embedding'
  | 'clustering';

/**
 * Progress of {@link DiarizationEngine.diarize}. `fraction` covers the whole
 * run (0..1); `currentSegment` / `totalSegments` count the steps of `phase`
 * (segmentation windows, speaker embeddings, then one clustering step).
 */
export interface DiarizationProgress extends OrchestrationProgress {
  /** Stage of the run. Omitted on the final event. */
  phase?: DiarizationProgressPhase;
}

export interface DiarizeOptions {
  /**
   * Progress while native code runs: per segmentation window, per speaker
   * embedding and for clustering (at most about one event per percent),
   * then a final event with `fraction: 1`.
   */
  onProgress?: (progress: DiarizationProgress) => void;
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
  segments?: Array<{
    start: number;
    end: number;
    speaker: number;
    /** Present when `clustering.computeConfidence` was enabled. Range [-1, 1]. */
    confidence?: number;
  }>;
}

export interface DiarizationReclusterOptions {
  numClusters?: number;
  threshold?: number;
  /** Override session confidence flag for this recluster. Default: keep prior. */
  computeConfidence?: boolean;
}

export interface DiarizationClusterEmbedding {
  speaker: number;
  embedding: Float32Array;
}

/** Duck-typed SID (or any gallery) used by {@link mapDiarizationToNames}. */
export type DiarizationNameSearch = {
  search(
    embedding: Float32Array,
    options?: { threshold?: number }
  ): Promise<string | null>;
};

export type MapDiarizationToNamesOptions = {
  /** Cosine similarity threshold in `[0, 1]`. Default `0.5`. */
  threshold?: number;
  /**
   * Stops the call. Checked before each name search and before each page of
   * segments is read. On abort the promise rejects with `code:
   * 'ORCHESTRATION_CANCELLED'` (`name: 'AbortError'`).
   */
  signal?: AbortSignal;
};

export type NamedDiarizationSpan = {
  startSample: number;
  endSample: number;
  sampleRate: number;
  startSec: number;
  endSec: number;
  clusterId: number;
  name: string | null;
};

export type MapDiarizationToNamesResult = {
  clusterToName: Map<number, string | null>;
  timeline: NamedDiarizationSpan[];
};

export interface DiarizationEngine {
  readonly instanceId: string;
  readonly sampleRate: number;
  /**
   * Cluster speakers in offline audio and write spans into `segmentOut`.
   * @throws {Error} `DIARIZATION_INVALID_ARGUMENT` — buffers or options are invalid.
   * @throws {Error} `DIARIZATION_CANCELLED` (`name: 'AbortError'`) — `options.signal` aborted before or during the call. A cancel without the signal (`cancelDiarization`) resolves with `status: 'cancelled'`.
   * @throws {Error} `DIARIZATION_ERROR` — native diarize failed.
   * @throws {Error} `DIARIZATION_BUFFER_NOT_FOUND` — audio or segment buffer is unknown.
   * @throws {Error} `DIARIZATION_NOT_INITIALIZED` — engine is not initialized.
   * @throws {Error} `OFFLINE_OOM` — native ran out of memory (try a larger `segmentation.windowShiftRatio` or shorter audio before retrying).
   */
  diarize(
    audioIn: OfflineAudioBufferIdSource,
    segmentOut: OfflineSegmentBufferIdSource | OfflineSegmentBufferRef,
    options?: DiarizeOptions
  ): Promise<DiarizeResult>;
  /**
   * Re-run clustering on the last diarize result.
   * @throws {Error} `DIARIZATION_INVALID_ARGUMENT` — recluster options are invalid.
   * @throws {Error} `DIARIZATION_ERROR` — native recluster failed.
   * @throws {Error} `DIARIZATION_NOT_INITIALIZED` — engine is not initialized.
   */
  recluster(options?: DiarizationReclusterOptions): Promise<DiarizeResult>;
  /**
   * Return per-cluster embeddings from the last diarize.
   * @throws {Error} `DIARIZATION_ERROR` — native embedding read failed.
   * @throws {Error} `DIARIZATION_NOT_INITIALIZED` — engine is not initialized.
   */
  getClusterEmbeddings(): Promise<DiarizationClusterEmbedding[]>;
  destroy(): Promise<void>;
}
