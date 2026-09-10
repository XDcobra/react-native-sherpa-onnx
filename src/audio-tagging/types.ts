import type { FileSource } from '../fileio/types';
import type { QuantizationPreference } from '../download/types';
import type {
  LiveAudioBufferIdSource,
  OfflineAudioBufferIdSource,
} from '../audiobuffer/types';
import type { LiveOfflinePipelineBaseOptions } from '../livePipeline';
import type {
  LiveSegmentBufferIdSource,
  OfflineSegmentBufferIdSource,
} from '../segmentbuffer/types';
import type { SegmentationPolicy } from '../segment/engine-types';
import type {
  ErrorRecoveryStrategy,
  OrchestrationProgress,
} from '../pipeline/offlineOrchestrator';
import type { LiveTextBufferIdSource } from '../textbuffer/types';
import type { AudioTaggingCustomConfig } from './customConfig';
import type { AudioTaggingPipelineHandle } from './streamingTypes';

export type AudioTaggingModelType = 'ced' | 'zipformer';

export const AUDIO_TAGGING_MODEL_TYPES: readonly AudioTaggingModelType[] = [
  'ced',
  'zipformer',
] as const;

export type AudioTaggingConcreteModelType = AudioTaggingModelType;

export const DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY: SegmentationPolicy = {
  evaluator: 'speech_energy_silence',
  silenceThresholdMs: 500,
  energyThresholdDb: -40,
  minSegmentMs: 1500,
  maxSegmentMs: 25000,
  hangoverMs: 300,
};

/**
 * Live OfflineLive workers skip spans shorter than this (Android/iOS).
 * Energy / continuous_frames policies must produce windows ≥ this floor.
 */
export const AUDIO_TAGGING_LIVE_MIN_SPAN_MS = 1500;

export const AudioTaggingErrorCode = {
  INVALID_ARGUMENT: 'AUDIO_TAGGING_INVALID_ARGUMENT',
  INIT_FAILED: 'AUDIO_TAGGING_INIT_FAILED',
  DESTROYED: 'AUDIO_TAGGING_DESTROYED',
  TAG_FAILED: 'AUDIO_TAGGING_TAG_FAILED',
  NOT_IMPLEMENTED: 'AUDIO_TAGGING_NOT_IMPLEMENTED',
} as const;

export type AudioTaggingInitOptionsShared = {
  /** Default top-K applied when `tag()` omits `topK`. */
  topK?: number;
  numThreads?: number;
  provider?: string;
  debug?: boolean;
};

export type AudioTaggingAutoInitializeOptions =
  AudioTaggingInitOptionsShared & {
    initMode?: 'auto';
    modelSource: FileSource;
    quantization?: QuantizationPreference;
    modelType?: AudioTaggingModelType | 'auto';
  };

export type AudioTaggingCustomInitializeOptions =
  AudioTaggingInitOptionsShared & {
    initMode: 'custom';
    modelType: AudioTaggingConcreteModelType;
    customConfig: AudioTaggingCustomConfig;
  };

export type AudioTaggingInitializeOptions =
  | AudioTaggingAutoInitializeOptions
  | AudioTaggingCustomInitializeOptions;

export type AudioTaggingTagOptions = {
  topK?: number;
  segmentation?: {
    mode?: 'off' | 'manual' | 'auto';
    policy?: SegmentationPolicy;
  };
  errorRecovery?: ErrorRecoveryStrategy;
  onProgress?: (progress: OrchestrationProgress) => void;
  onSegment?: (event: AudioTaggingSegmentEvent) => void;
  /** Optional OfflineSegmentBuffer to populate with AudioTaggingSpeechSegmentPayload. */
  targetSegmentBuffer?: OfflineSegmentBufferIdSource;
};

export type AudioTaggingEvent = {
  name: string;
  index: number;
  prob: number;
};

export type AudioTaggingResult = {
  events: AudioTaggingEvent[];
  /** Highest-probability event, when any events were returned. */
  primary?: AudioTaggingEvent;
  audioDuration: number;
  elapsedMs: number;
  topK: number;
};

export type AudioTaggingSegmentEvent = {
  segmentIndex: number;
  totalSegments: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  result: AudioTaggingResult;
};

export type SegmentedAudioTaggingResult = {
  segments: AudioTaggingSegmentEvent[];
  totalSegments: number;
  processingTimeMs: number;
};

/** Live `onSegment` event mapped from LiveText commits. */
export type AudioTaggingLiveSegmentEvent = {
  segmentIndex: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  result: AudioTaggingResult;
};

/**
 * Options for Mode 3 live overload:
 * `tag(liveAudio, liveText, options)`.
 */
export interface AudioTaggingLivePipelineOptions
  extends LiveOfflinePipelineBaseOptions {
  topK?: number;
  onSegment?: (event: AudioTaggingLiveSegmentEvent) => void;
  /** Optional live segment buffer to annotate with AudioTaggingSpeechSegmentPayload. */
  targetSegmentBuffer?: LiveSegmentBufferIdSource;
}

export interface AudioTaggingEngine {
  readonly instanceId: string;

  /** Mode 1: Offline oneshot. Mode 2: Offline segmented when segmentation.mode=auto. */
  tag(
    offlineAudio: OfflineAudioBufferIdSource,
    options?: AudioTaggingTagOptions
  ): Promise<AudioTaggingResult | SegmentedAudioTaggingResult>;

  /**
   * Mode 3: Live overload — mandatory segmentation; commits primary event name
   * (+ meta top-K) into LiveText; optional live targetSegmentBuffer.
   */
  tag(
    audioIn: LiveAudioBufferIdSource,
    textOut: LiveTextBufferIdSource,
    options: AudioTaggingLivePipelineOptions
  ): Promise<AudioTaggingPipelineHandle>;

  destroy(): Promise<void>;
}
