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
import type { OrchestrationProgress } from '../pipeline/offlineOrchestrator';
import type { SegmentationPolicy } from '../segment/engine-types';

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

/** Concrete VAD model types (excludes `'auto'`). */
export type VADConcreteModelType = VADModelType;

/** Shared VAD init fields for auto and custom modes. */
export type VADInitOptionsShared = {
  sampleRate?: number;
  runtimeOptions?: VADRuntimeOptions;
  provider?: string;
  numThreads?: number;
  debug?: boolean;
};

/** Automatic model detection from a model directory (default). */
export type VADAutoInitializeOptions = VADInitOptionsShared & {
  initMode?: 'auto';
  modelSource: FileSource;
  modelType?: VADModelType | 'auto';
};

/** Explicit model file path; skips native auto-detection. */
export type VADCustomInitializeOptions = VADInitOptionsShared & {
  initMode: 'custom';
  modelType: VADConcreteModelType;
  customConfig: import('./customConfig').VadCustomConfig;
};

/**
 * Configuration for VAD initialization. Discriminated by `initMode`:
 * auto mode scans a model directory; custom mode supplies an explicit {@link FileSource} for the ONNX file.
 */
export type VADInitializeOptions =
  | VADAutoInitializeOptions
  | VADCustomInitializeOptions;

export type VADLiveRunOptions = {
  /**
   * How many samples to drain from the live audio cursor per pump (streaming pipeline only).
   * Offline `createStreamingVAD().process()` uses the model `windowSize` from runtime options, not this field.
   */
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
  sourceTag?: string;
  /**
   * When omitted or `mode: 'off'`, offline VAD runs a single native pass over the full buffer.
   * When `mode: 'auto'`, the segmentation engine splits offline audio into speech segments and
   * runs VAD per segment (see `src/vad/engine.ts` offline branch).
   */
  segmentation?: {
    mode?: 'off' | 'auto';
    policy?: SegmentationPolicy;
  };
  /**
   * Emitted only for **segmented** offline runs (`segmentation.mode: 'auto'` with at least one
   * speech segment). Not called for `mode: 'off'` (single native pass), matching offline STT
   * single-pass behaviour. Payload matches `OrchestrationProgress` in `pipeline/offlineOrchestrator.ts`.
   */
  onProgress?: (progress: OrchestrationProgress) => void;
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

export type { OrchestrationProgress };

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
