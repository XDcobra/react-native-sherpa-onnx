import type { FileSource } from '../fileio/types';
import type { QuantizationPreference } from '../download/types';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type { AudioTaggingCustomConfig } from './customConfig';

export type AudioTaggingModelType = 'ced' | 'zipformer';

export const AUDIO_TAGGING_MODEL_TYPES: readonly AudioTaggingModelType[] = [
  'ced',
  'zipformer',
] as const;

export type AudioTaggingConcreteModelType = AudioTaggingModelType;

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

/** Phase 2 oneshot options. Segmentation arrives in Phase 3. */
export type AudioTaggingTagOptions = {
  topK?: number;
  /** Rejected in Phase 2 when `mode === 'auto'`. */
  segmentation?: { mode?: 'off' | 'manual' | 'auto' };
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

export interface AudioTaggingEngine {
  readonly instanceId: string;
  tag(
    offlineAudio: OfflineAudioBufferIdSource,
    options?: AudioTaggingTagOptions
  ): Promise<AudioTaggingResult>;
  destroy(): Promise<void>;
}
