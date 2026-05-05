import type { FileSource } from '../fileio/types';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferRef,
  LiveTextBufferIdSource,
} from '../textbuffer/types';
import type {
  OrchestrationProgress,
  ErrorRecoveryStrategy,
  RetryExhaustedFallback,
} from '../pipeline/offlineOrchestrator';
import type { SegmentationPolicy } from '../segment/engine-types';
import type { SegmentLinkMapRef } from '../segment/segment-link';
import type { TextSegment } from '../segment/segment';
import type { LiveOfflinePipelineBaseOptions } from '../livePipeline';
import type { PunctuationPipelineHandle } from './streamingTypes';

/** v1: only `processingTimeMs` (native punctuate duration in milliseconds). */
export type OfflinePunctuateResult = {
  processingTimeMs: number;
  status?: 'complete' | 'partial' | 'failed' | 'cancelled';
  totalSegments?: number;
  completedSegments?: number;
  skippedSegments?: Array<{
    segmentIndex: number;
    segmentId: string;
    error: string;
    retryCount: number;
  }>;
  failedSegment?: {
    segmentIndex: number;
    segmentId: string;
    error: string;
    retryCount: number;
  };
};

export type OfflinePunctuationSegmentationMode = 'off' | 'manual' | 'auto';

export type OfflinePunctuateOptions = {
  segmentation?: {
    mode?: OfflinePunctuationSegmentationMode;
    policy?: SegmentationPolicy;
  };
  errorRecovery?: ErrorRecoveryStrategy;
  maxRetriesPerSegment?: number;
  retryExhaustedFallback?: RetryExhaustedFallback;
  abortSignal?: AbortSignal;
  onProgress?: (progress: OrchestrationProgress) => void;
  overlapChars?: number;
  textSkipPlaceholder?: string;
  linkMap?: SegmentLinkMapRef;
};

export type OfflinePunctuationModelType = 'ct_transformer' | 'auto';

export type OfflinePunctuationInitializeOptions = {
  /** Directory-backed model source used for punctuation initialization. */
  modelSource: FileSource;
  /**
   * `'auto'` resolves **offline CT only** (same as `ct_transformer` for native detect).
   * Does not select online/CNN layout.
   */
  modelType?: OfflinePunctuationModelType;
  numThreads?: number;
  provider?: string;
  debug?: boolean;
};

export type OfflinePunctuationEngine = {
  readonly instanceId: string;

  // Existing batch overload (unchanged).
  punctuate(
    textIn: OfflineTextBufferIdSource,
    textOut: OfflineTextBufferIdSource,
    options?: OfflinePunctuateOptions
  ): Promise<OfflinePunctuateResult>;

  // Live overload — offline CT weights consumed in a live pipeline.
  punctuate(
    textIn: LiveTextBufferIdSource,
    textOut: LiveTextBufferIdSource,
    options: PunctuationLivePipelineOptions
  ): Promise<PunctuationPipelineHandle>;

  /** Caller-owned `textOut` buffer; engine only populates it. */
  punctuateString(
    plain: string,
    textOut: OfflineTextBufferRef,
    options?: OfflinePunctuateOptions
  ): Promise<OfflinePunctuateResult>;
  destroy(): Promise<void>;
};

export interface PunctuationLivePipelineOptions
  extends LiveOfflinePipelineBaseOptions {
  /**
   * Optional mirror callback for each committed punctuated output segment.
   * Commit-only path: no partial callback is exposed.
   */
  onSegment?: (segment: TextSegment) => void;
}
