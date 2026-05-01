import type { ModelPathConfig } from '../fileio/types';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferRef,
} from '../textbuffer/types';
import type {
  OrchestrationProgress,
  ErrorRecoveryStrategy,
  RetryExhaustedFallback,
} from '../pipeline/offlineOrchestrator';
import type { SegmentationPolicy } from '../segment/engine-types';
import type { SegmentLinkMapRef } from '../segment/segment-link';

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
  /** Same shape as `createEnhancement` / `resolveModelPath` (`type` + `path`), not `FileSource`. */
  modelPath: ModelPathConfig;
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
  punctuate(
    textIn: OfflineTextBufferIdSource,
    textOut: OfflineTextBufferIdSource,
    options?: OfflinePunctuateOptions
  ): Promise<OfflinePunctuateResult>;
  /** Caller-owned `textOut` buffer; engine only populates it. */
  punctuateString(
    plain: string,
    textOut: OfflineTextBufferRef,
    options?: OfflinePunctuateOptions
  ): Promise<OfflinePunctuateResult>;
  destroy(): Promise<void>;
};
