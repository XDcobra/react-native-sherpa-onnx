import type { LiveAudioBufferIdSource } from '../audiobuffer/types';
import type { StreamingPipelineHandle } from '../audiobuffer/streamingPipelineTypes';
import type { QuantizationPreference } from '../download/types';
import type { FileSource } from '../fileio/types';
import type { LiveTextBufferIdSource } from '../textbuffer/types';

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

export interface KeywordDetection {
  keyword: string;
  tokens: string[];
  timestamps: number[];
  startTime?: number;
}

export interface KeywordSpottingPipelineOptions {
  /** Samples per drain from the live audio ring. Native default is 6400. */
  chunkSize?: number;
  /** Optional per-session keywords override (sherpa createStream(keywords)). */
  keywords?: string;
  /** Fired for each keyword hit (also committed to the live text buffer). */
  onKeyword?: (event: KeywordDetection & { segmentIndex: number }) => void;
}

/**
 * Initialized native KWS engine with real streaming `spot(...)`.
 */
export interface KeywordSpottingEngine {
  readonly instanceId: string;
  spot(
    audioIn: LiveAudioBufferIdSource,
    textOut: LiveTextBufferIdSource,
    options?: KeywordSpottingPipelineOptions
  ): Promise<StreamingPipelineHandle & { instanceId: string }>;
  destroy(): Promise<void>;
}
