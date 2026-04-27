import type { ModelPathConfig } from '../types';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferRef,
} from '../textbuffer/types';

/** v1: only `processingTimeMs` (native punctuate duration in milliseconds). */
export type OfflinePunctuateResult = {
  processingTimeMs: number;
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
    textOut: OfflineTextBufferIdSource
  ): Promise<OfflinePunctuateResult>;
  /** Caller-owned `textOut` buffer; engine only populates it. */
  punctuateString(
    plain: string,
    textOut: OfflineTextBufferRef
  ): Promise<OfflinePunctuateResult>;
  destroy(): Promise<void>;
};
