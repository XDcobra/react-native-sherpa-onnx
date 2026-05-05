import type { FileSource } from '../fileio/types';
import type { VadDetectModelResult } from '../types/modelDetect';
import type {
  LiveAudioBufferIdSource,
  OfflineAudioBufferIdSource,
} from '../audiobuffer/types';
import type {
  LiveSegmentBufferIdSource,
  OfflineSegmentBufferIdSource,
} from '../segmentbuffer/types';

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type ModelDetectResultBase,
  type VadDetectModelResult,
} from '../types/modelDetect';

export type VADModelType = 'silero_vad' | 'ten_vad';

export const VAD_MODEL_TYPES: readonly VADModelType[] = [
  'silero_vad',
  'ten_vad',
] as const;

export type VADPipelineStatus = {
  pipelineId: string;
  isRunning: boolean;
  isFlushing: boolean;
  queueDepth: number;
  chunksProcessed: number;
  unitsRead: number;
  unitsWritten: number;
  error: string | null;
};

export type VADSummary = {
  chunksProcessed: number;
  unitsRead: number;
  unitsWritten: number;
  segmentCount: number;
  speechDurationMs: number;
};

export type VADRuntimeTuningOptions = {
  scoreThreshold?: number;
  minSilenceDurationMs?: number;
  minSpeechDurationMs?: number;
  maxSpeechDurationMs?: number;
  windowSize?: number;
};

export type SileroVadRuntimeOptions = {
  sileroVad: VADRuntimeTuningOptions;
  tenVad?: never;
};

export type TenVadRuntimeOptions = {
  tenVad: VADRuntimeTuningOptions;
  sileroVad?: never;
};

export type VADRuntimeOptions = SileroVadRuntimeOptions | TenVadRuntimeOptions;

export type VADInitializeOptions = {
  modelSource: FileSource;
  modelType?: VADModelType | 'auto';
  sampleRate?: number;
  runtimeOptions?: VADRuntimeOptions;
  provider?: string;
  numThreads?: number;
  debug?: boolean;
};

export type VADLiveRunOptions = {
  chunkSize?: number;
  autoFlushOnInputEnded?: boolean;
  sourceTag?: string;
  /**
   * Minimum time between `onSpeechStateChanged` invocations on the returned pipeline handle.
   * `0` (default) = unthrottled.
   */
  speechStateEventMinIntervalMs?: number;
};

export type VADOfflineRunOptions = {
  chunkSize?: number;
  sourceTag?: string;
};

export type VADRunOptions = VADLiveRunOptions | VADOfflineRunOptions;

/** Payload for {@link VADPipelineHandle.onSpeechStateChanged} (VAD live activity, not segment data). */
export type VADSpeechStateChangedEvent = {
  isSpeechDetected: boolean;
  pipelineId: string;
  ts?: number;
};

export type VADOfflineResult = {
  summary: VADSummary;
  segmentBufferId: string;
};

export type VADDetectResult = VadDetectModelResult;

export type VADPipelineHandle = {
  instanceId: string;
  pipelineId: string;
  completed: Promise<VADSummary>;
  /**
   * Optional: react to VAD speech/activity without polling.
   * Throttle with `speechStateEventMinIntervalMs` in `VADLiveRunOptions` when starting the live pipeline.
   */
  onSpeechStateChanged?: (event: VADSpeechStateChangedEvent) => void;
  stop(): Promise<void>;
  flush(): Promise<void>;
  reset(): Promise<void>;
  getStatus(): Promise<VADPipelineStatus>;
};

export type VADLiveProcessInput = {
  audioIn: LiveAudioBufferIdSource;
  segmentOut: LiveSegmentBufferIdSource;
  options?: VADLiveRunOptions;
};

export type VADOfflineProcessInput = {
  audioIn: OfflineAudioBufferIdSource;
  segmentOut: OfflineSegmentBufferIdSource | LiveSegmentBufferIdSource;
  options?: VADOfflineRunOptions;
};

export interface VADEngine {
  readonly instanceId: string;
  process(
    input: VADLiveProcessInput | VADOfflineProcessInput
  ): Promise<VADPipelineHandle | VADOfflineResult>;
  isSpeechDetected(): Promise<boolean>;
  destroy(): Promise<void>;
}
