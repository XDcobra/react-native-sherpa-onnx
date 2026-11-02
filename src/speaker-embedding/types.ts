import type { FileSource } from '../fileio/types';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type { SpeakerEmbeddingDetectModelResult } from '../types/modelDetect';
import type { SpeakerEmbeddingCustomConfig } from './customConfig';
import type { QuantizationPreference } from '../download/types';

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
    quantization?: QuantizationPreference;
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
  /**
   * Extract one embedding from an offline audio buffer, optionally cropped to `range`.
   * @throws {Error} `SPEAKER_EMBEDDING_COMPUTE_ERROR` — native extract failed.
   * @throws {Error} `SPEAKER_EMBEDDING_INVALID_ARGUMENT` — range or buffer args are invalid.
   * @throws {Error} `SPEAKER_EMBEDDING_BUFFER_NOT_FOUND` — audio buffer is unknown.
   * @throws {Error} `SPEAKER_EMBEDDING_BUFFER_EMPTY` — audio buffer has no samples.
   * @throws {Error} `SPEAKER_EMBEDDING_BUFFER_KIND_MISMATCH` — buffer is not offline audio.
   * @throws {Error} `OFFLINE_OOM` — native ran out of memory.
   */
  extractFromOfflineAudio(
    audio: OfflineAudioBufferIdSource,
    range?: SpeakerEmbeddingExtractRange
  ): Promise<Float32Array>;
  destroy(): Promise<void>;
}

export interface SpeakerEmbeddingManager {
  readonly managerId: string;
  readonly dim: number;
  /**
   * Enroll `name` with one or more embeddings of this manager's `dim`.
   * @throws {Error} `SPEAKER_EMBEDDING_MANAGER_ERROR` — native add failed.
   */
  add(name: string, embeddings: Float32Array[]): Promise<boolean>;
  /**
   * Remove an enrolled speaker.
   * @throws {Error} `SPEAKER_EMBEDDING_MANAGER_ERROR` — native remove failed.
   */
  remove(name: string): Promise<boolean>;
  /**
   * Search for the closest enrolled name above `threshold`.
   * @throws {Error} `SPEAKER_EMBEDDING_MANAGER_ERROR` — native search failed.
   */
  search(embedding: Float32Array, threshold: number): Promise<string>;
  /**
   * Verify that `embedding` matches enrolled `name` above `threshold`.
   * @throws {Error} `SPEAKER_EMBEDDING_MANAGER_ERROR` — native verify failed.
   */
  verify(
    name: string,
    embedding: Float32Array,
    threshold: number
  ): Promise<boolean>;
  /**
   * Whether `name` is enrolled.
   * @throws {Error} `SPEAKER_EMBEDDING_MANAGER_ERROR` — native lookup failed.
   */
  contains(name: string): Promise<boolean>;
  /**
   * Number of enrolled speakers.
   * @throws {Error} `SPEAKER_EMBEDDING_MANAGER_ERROR` — native count failed.
   */
  numSpeakers(): Promise<number>;
  /**
   * List enrolled speaker names.
   * @throws {Error} `SPEAKER_EMBEDDING_MANAGER_ERROR` — native list failed.
   */
  listSpeakers(): Promise<string[]>;
  /**
   * Stored averaged embedding for `name`, or `null` if the name is not enrolled.
   * @throws {Error} `SPEAKER_EMBEDDING_MANAGER_ERROR` — empty name or native readout failed.
   */
  getEmbedding(name: string): Promise<Float32Array | null>;
  destroy(): Promise<void>;
}
