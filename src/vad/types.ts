import type { ModelPathConfig } from '../types';
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

export type VADInitializeOptions = {
  modelPath: ModelPathConfig;
  modelType?: VADModelType | 'auto';
  sampleRate?: number;
  silenceDurationMs?: number;
  speechDurationMs?: number;
  maxSpeechDurationS?: number;
  minSpeechDurationMs?: number;
  threshold?: number;
  windowSize?: number;
  provider?: string;
  numThreads?: number;
  debug?: boolean;
};

export type VADLiveRunOptions = {
  chunkSize?: number;
  autoFlushOnInputEnded?: boolean;
  sourceTag?: string;
};

export type VADOfflineRunOptions = {
  chunkSize?: number;
  sourceTag?: string;
};

export type VADRunOptions = VADLiveRunOptions | VADOfflineRunOptions;

export type VADEvent =
  | {
      type: 'pipeline.started';
      instanceId: string;
      pipelineId: string;
      ts: number;
    }
  | {
      type: 'pipeline.progress';
      instanceId: string;
      pipelineId: string;
      ts: number;
      chunksProcessed: number;
      unitsRead: number;
      unitsWritten: number;
      queueDepth: number;
    }
  | {
      type: 'vad.stateChanged';
      instanceId: string;
      pipelineId: string;
      ts: number;
      isSpeechDetected: boolean;
    }
  | {
      type: 'segment.appended';
      instanceId: string;
      pipelineId: string;
      ts: number;
      segmentId: string;
      segmentIndex: number;
    }
  | {
      type: 'pipeline.flushed';
      instanceId: string;
      pipelineId: string;
      ts: number;
    }
  | {
      type: 'pipeline.completed';
      instanceId: string;
      pipelineId: string;
      ts: number;
      summary: VADSummary;
    }
  | {
      type: 'pipeline.error';
      instanceId: string;
      pipelineId: string;
      ts: number;
      error: string;
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
  addListener(listener: (event: VADEvent) => void): () => void;
  isSpeechDetected(): Promise<boolean>;
  destroy(): Promise<void>;
}
