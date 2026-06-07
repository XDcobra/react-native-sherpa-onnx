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
import type { TextInputNormalization } from './textInputNormalization';

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
  /** Default: `'lower'`. */
  textInputNormalization?: TextInputNormalization;
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

export type OfflinePunctuationConcreteModelType = 'ct_transformer';

export type OfflinePunctuationInitOptionsShared = {
  numThreads?: number;
  provider?: string;
  debug?: boolean;
};

export type OfflinePunctuationAutoInitializeOptions =
  OfflinePunctuationInitOptionsShared & {
    initMode?: 'auto';
    /** Directory-backed model source used for punctuation initialization. */
    modelSource: FileSource;
    /**
     * `'auto'` resolves **offline CT only** (same as `ct_transformer` for native detect).
     * Does not select online/CNN layout.
     */
    modelType?: OfflinePunctuationModelType;
  };

export type OfflinePunctuationCustomInitializeOptions =
  OfflinePunctuationInitOptionsShared & {
    initMode: 'custom';
    modelType: OfflinePunctuationConcreteModelType;
    customConfig: import('./customConfig').OfflinePunctuationCustomConfig;
  };

export type OfflinePunctuationInitializeOptions =
  | OfflinePunctuationAutoInitializeOptions
  | OfflinePunctuationCustomInitializeOptions;

export type OfflinePunctuationEngine = {
  readonly instanceId: string;

  /**
   * Batch punctuation on offline text buffers.
   * Reads from an `OfflineTextBuffer` and writes punctuated text into an
   * offline output buffer.
   */
  punctuate(
    textIn: OfflineTextBufferIdSource,
    textOut: OfflineTextBufferIdSource,
    options?: OfflinePunctuateOptions
  ): Promise<OfflinePunctuateResult>;

  /**
   * Live overload on the offline CT punctuation engine.
   * Consumes committed text segments from a `LiveTextBuffer` and writes
   * punctuated committed segments to a live output buffer.
   * Segmentation policy is mandatory for this path.
   */
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
  /** Default: `'lower'`. */
  textInputNormalization?: TextInputNormalization;
  /**
   * Optional mirror callback for each committed punctuated output segment.
   * Commit-only path: no partial callback is exposed.
   */
  onSegment?: (segment: TextSegment) => void;
}
