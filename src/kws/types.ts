import type { QuantizationPreference } from '../download/types';
import type { FileSource } from '../fileio/types';

export interface KeywordSpottingInitOptions {
  /** Directory-backed KWS model source. */
  modelSource: FileSource;
  /** Optional absolute keyword-file path replacing the detected keywords.txt. */
  keywordsPath?: string;
  /** Keyword boosting score. Defaults to 1.5. */
  keywordsScore?: number;
  /** Trigger threshold. Defaults to 0.25. */
  keywordsThreshold?: number;
  /** Required trailing blanks before finalizing a hit. Defaults to 2. */
  numTrailingBlanks?: number;
  /** Maximum active decoding paths. Defaults to 4. */
  maxActivePaths?: number;
  /** Native inference thread count. */
  numThreads?: number;
  /** ONNX Runtime provider. Defaults to cpu. */
  provider?: string;
  /** Enable native model debug logging. */
  debug?: boolean;
  /** Quantization preference used while detecting model files. */
  quantization?: QuantizationPreference;
}

/**
 * Initialized native KWS engine.
 *
 * Phase 2 exposes lifecycle only; streaming `spot(...)` arrives with the native
 * pipeline worker.
 */
export interface KeywordSpottingEngine {
  readonly instanceId: string;
  destroy(): Promise<void>;
}
