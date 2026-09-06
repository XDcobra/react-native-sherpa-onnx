import type { FileSource } from '../fileio/types';
import type {
  LiveAudioBufferIdSource,
  OfflineAudioBufferIdSource,
} from '../audiobuffer/types';
import type { LiveSegmentBufferIdSource } from '../segmentbuffer/types';
import type {
  StreamingPipelineCompletion,
  StreamingPipelineStatus,
} from '../audiobuffer/streamingPipelineTypes';
import type { DiarizationCustomConfig } from './customConfig';

export type StreamingDiarizationConcreteModelType = 'sortformer';
export type StreamingDiarizationModelType = 'sortformer' | 'auto';

export interface StreamingDiarizationInitOptionsShared {
  numThreads?: number;
  provider?: string;
  debug?: boolean;

  /** Onset probability threshold for hysteresis (default 0.5) */
  onset?: number;
  /** Offset probability threshold for hysteresis (default 0.5) */
  offset?: number;
  /** Seconds to pad before segment onset (default 0.0) */
  padOnset?: number;
  /** Seconds to pad after segment offset (default 0.0) */
  padOffset?: number;
  /** Minimum segment duration in seconds to keep (default 0.0) */
  minDurationOn?: number;
  /** Maximum gap between segments in seconds to merge (default 0.5) */
  minDurationOff?: number;
  /** Filter window size for median filter across time (default 11) */
  medianWindow?: number;
}

export type StreamingDiarizationAutoInitializeOptions =
  StreamingDiarizationInitOptionsShared & {
    initMode?: 'auto';
    modelSource: FileSource;
    modelType?: StreamingDiarizationModelType;
  };

export type StreamingDiarizationCustomInitializeOptions =
  StreamingDiarizationInitOptionsShared & {
    initMode: 'custom';
    modelType: StreamingDiarizationConcreteModelType;
    customConfig: DiarizationCustomConfig;
  };

export type StreamingDiarizationInitializeOptions =
  | StreamingDiarizationAutoInitializeOptions
  | StreamingDiarizationCustomInitializeOptions;

export interface StreamingDiarizationOptions {
  /**
   * Number of samples to drain per read iteration (default 4096 = 256ms at 16kHz).
   */
  chunkSize?: number;
}

export interface DiarizationPipelineHandle {
  readonly instanceId: string;
  readonly pipelineId: string;
  readonly completed: Promise<StreamingPipelineCompletion>;
  stop(): Promise<void>;
  flush(): Promise<void>;
  reset(): Promise<void>;
  getStatus(): Promise<StreamingPipelineStatus>;
}

export interface StreamingDiarizationEngine {
  readonly instanceId: string;
  readonly sampleRate: number;
  readonly maxSpeakers: number;
  readonly feedSamples: number;
  readonly strideSamples: number;
  readonly latencySeconds: number;

  /**
   * Starts a zero-JS background worker draining audio directly from `audioIn`
   * and writing detected speaker segments into `segmentOut`.
   */
  startPipeline(
    audioIn: LiveAudioBufferIdSource,
    segmentOut: LiveSegmentBufferIdSource,
    options?: StreamingDiarizationOptions
  ): Promise<DiarizationPipelineHandle>;

  /**
   * Feed a chunk of offline audio samples to the engine manually.
   */
  feed(
    audioIn: OfflineAudioBufferIdSource
  ): Promise<Array<{ start: number; end: number; speaker: number }>>;

  /**
   * Flush remaining buffered audio, returning final detected segments.
   */
  flush(): Promise<Array<{ start: number; end: number; speaker: number }>>;

  /**
   * Reset internal streaming states (FIFO, speaker cache, silence tracking).
   */
  reset(): Promise<void>;

  /**
   * Release native resources and unload model.
   */
  release(): Promise<void>;
}
