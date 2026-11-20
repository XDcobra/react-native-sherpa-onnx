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
import type { QuantizationPreference } from '../download/types';

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
  quantization?: QuantizationPreference;
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
  /**
   * Called for each speech segment as soon as it is written, in input order.
   * Only for **segmented** offline runs (`segmentation.mode: 'auto'`); with
   * `mode: 'off'` the single native pass writes all segments at once and this
   * is not called (read `segmentOut` after the call). Errors thrown by the
   * callback are ignored.
   */
  onSegment?: (segment: VADOfflineSegmentEvent) => void;
  /**
   * Stops the offline call. Checked before the call and before each segment
   * (`segmentation.mode: 'auto'`); a segment that is already running finishes
   * first. With `mode: 'off'` only an abort before the start has an effect.
   * On abort the promise rejects with `code: 'ORCHESTRATION_CANCELLED'`
   * (`name: 'AbortError'`) and the SDK releases its slice and staging
   * buffers. An offline `segmentOut` stays empty; a live `segmentOut` keeps
   * the segments appended before the abort.
   */
  signal?: AbortSignal;
};

/** One speech segment of an offline run, passed to `VADOfflineRunOptions.onSegment`. */
export type VADOfflineSegmentEvent = {
  /** 0-based position of the segment among the segments written so far. */
  segmentIndex: number;
  /** Segment range in the input audio, in samples. */
  startSample: number;
  endSample: number;
  sampleRate: number;
  /** Segment range in the input audio, in ms. */
  startMs: number;
  endMs: number;
  durationMs: number;
  confidence?: number;
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
  /**
   * Run VAD on live or offline audio.
   * @throws {Error} `VAD_INVALID_STATE` — a pipeline is already running.
   * @throws {Error} `VAD_INVALID_OPTIONS` — `onProgress` or `onSegment` is not a function.
   * @throws {Error} `VAD_BUFFER_NOT_FOUND` — audio or segment buffer is unknown.
   * @throws {Error} `VAD_BUFFER_KIND_MISMATCH` — buffer is not the required kind.
   * @throws {Error} `VAD_INTERNAL_ERROR` — native VAD failed.
   * @throws {Error} `ORCHESTRATION_CANCELLED` — offline `options.signal` aborted.
   */
  process(
    input: VADLiveProcessInput | VADOfflineProcessInput
  ): Promise<VADPipelineHandle | VADOfflineResult>;
  /**
   * Whether the last processed window contained speech.
   * @throws {Error} `VAD_MODEL_INIT_FAILED` — the VAD model is not loaded.
   */
  isSpeechDetected(): Promise<boolean>;
  destroy(): Promise<void>;
}
