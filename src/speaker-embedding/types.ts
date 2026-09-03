import type { FileSource } from '../fileio/types';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type { SpeakerEmbeddingDetectModelResult } from '../types/modelDetect';
import type { SpeakerEmbeddingCustomConfig } from './customConfig';

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type SpeakerEmbeddingDetectModelResult,
  type ModelDetectResultBase,
} from '../types/modelDetect';

export type SpeakerEmbeddingModelType = 'wespeaker' | '3d-speaker' | 'nemo';

export const SPEAKER_EMBEDDING_MODEL_TYPES: readonly SpeakerEmbeddingModelType[] =
  ['wespeaker', '3d-speaker', 'nemo'] as const;

export type SpeakerEmbeddingConcreteModelType = SpeakerEmbeddingModelType;

export type SpeakerEmbeddingDetectResult = SpeakerEmbeddingDetectModelResult;

export type SpeakerEmbeddingInitOptionsShared = {
  numThreads?: number;
  provider?: string;
  debug?: boolean;
};

export type SpeakerEmbeddingAutoInitializeOptions =
  SpeakerEmbeddingInitOptionsShared & {
    initMode?: 'auto';
    modelSource: FileSource;
    modelType?: SpeakerEmbeddingModelType | 'auto';
  };

export type SpeakerEmbeddingCustomInitializeOptions =
  SpeakerEmbeddingInitOptionsShared & {
    initMode: 'custom';
    modelType: SpeakerEmbeddingConcreteModelType;
    customConfig: SpeakerEmbeddingCustomConfig;
  };

export type SpeakerEmbeddingInitializeOptions =
  | SpeakerEmbeddingAutoInitializeOptions
  | SpeakerEmbeddingCustomInitializeOptions;

export type SpeakerEmbeddingExtractRange = {
  startSample: number;
  endSample: number;
};

export interface SpeakerEmbeddingEngine {
  readonly instanceId: string;
  readonly dim: number;
  extractFromOfflineAudio(
    audio: OfflineAudioBufferIdSource,
    range?: SpeakerEmbeddingExtractRange
  ): Promise<Float32Array>;
  destroy(): Promise<void>;
}

export interface SpeakerEmbeddingManager {
  readonly managerId: string;
  readonly dim: number;
  add(name: string, embeddings: Float32Array[]): Promise<boolean>;
  remove(name: string): Promise<boolean>;
  search(embedding: Float32Array, threshold: number): Promise<string>;
  verify(
    name: string,
    embedding: Float32Array,
    threshold: number
  ): Promise<boolean>;
  contains(name: string): Promise<boolean>;
  numSpeakers(): Promise<number>;
  listSpeakers(): Promise<string[]>;
  destroy(): Promise<void>;
}
