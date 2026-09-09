import type { LiveAudioBufferIdSource } from '../audiobuffer/types';
import type { StreamingPipelineHandle } from '../audiobuffer/streamingPipelineTypes';
import type { QuantizationPreference } from '../download/types';
import type { FileSource } from '../fileio/types';
import type { LiveTextBufferIdSource } from '../textbuffer/types';

/** Options for `createKeywordSpotting` / `createStreamingKWS`. */
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

/** One keyword hit emitted by `spot` / `onKeyword` (also committed to LiveTextBuffer). */
export interface KeywordDetection {
  /** Matched keyword label (from keywords.txt / stream override). */
  keyword: string;
  /** Token sequence for the hit (model inventory pieces). Empty when native omits tokens. */
  tokens: string[];
  /**
   * Per-token timestamps in seconds when the native result exposes them.
   * Empty when native omits timestamps.
   */
  timestamps: number[];
  /**
   * Keyword start time in seconds when the native result exposes it.
   * Present on iOS (sherpa C-API `start_time`). On Android the Kotlin
   * `KeywordSpotterResult` has no start-time field, so this is usually omitted.
   */
  startTime?: number;
}

/** Options for a single `spot(...)` streaming session. */
export interface KeywordSpottingPipelineOptions {
  /** Samples per drain from the live audio ring. Native default is 1600 (~100ms @ 16 kHz). */
  chunkSize?: number;
  /** Optional per-session keywords override (sherpa createStream(keywords)). */
  keywords?: string;
  /**
   * Fired for each keyword hit (also committed to the live text buffer as
   * `source=kws_stream`). `segmentIndex` is the committed LiveTextBuffer segment index.
   */
  onKeyword?: (event: KeywordDetection & { segmentIndex: number }) => void;
}

/**
 * Initialized native KWS engine with real streaming `spot(...)`.
 */
export interface KeywordSpottingEngine {
  /** Native instance id for this engine (TurboModule / unload key). */
  readonly instanceId: string;
  /**
   * Start real streaming keyword spotting.
   * Reads continuously from `audioIn`, commits hits to `textOut`, and returns a
   * shared streaming pipeline handle (`stop` / `flush` / `reset` / `completed`).
   *
   * `textOut` uses the normal LiveTextBuffer defaults (including spooling on/auto).
   * That is fine when you later want `fullIfSpooled` / offline transfer of hit history.
   * If you only consume `onKeyword` / `onSegment` and do not need spool replay, create
   * the buffer with `spooling: { mode: 'off' }` to avoid disk I/O on each hit — same
   * LiveTextBuffer default as STT/VAD; KWS does not override it.
   */
  spot(
    audioIn: LiveAudioBufferIdSource,
    textOut: LiveTextBufferIdSource,
    options?: KeywordSpottingPipelineOptions
  ): Promise<StreamingPipelineHandle & { instanceId: string }>;
  /** Stop any active pipeline and unload the native KeywordSpotter. Idempotent. */
  destroy(): Promise<void>;
}
