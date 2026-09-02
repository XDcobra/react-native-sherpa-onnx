import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type { SpeakerEmbeddingInitializeOptions } from '../speaker-embedding/types';

export type SpeakerIdentificationOptions = SpeakerEmbeddingInitializeOptions;

export type IdentifyResult = {
  /** Matched enrolled speaker name, or `null` when below threshold / unknown. */
  name: string | null;
};

export type SpeakerIdentificationThresholdOptions = {
  /** Cosine similarity threshold in `[0, 1]`. Default `0.5`. */
  threshold?: number;
};

export interface SpeakerIdentificationEngine {
  readonly instanceId: string;
  readonly managerId: string;
  readonly dim: number;

  /**
   * Enroll a named speaker from one or more offline audio buffers.
   * Multiple clips are averaged (L2-normalized) by the native manager.
   */
  enroll(
    name: string,
    audio: OfflineAudioBufferIdSource | OfflineAudioBufferIdSource[]
  ): Promise<void>;

  identify(
    audio: OfflineAudioBufferIdSource,
    options?: SpeakerIdentificationThresholdOptions
  ): Promise<IdentifyResult>;

  verify(
    name: string,
    audio: OfflineAudioBufferIdSource,
    options?: SpeakerIdentificationThresholdOptions
  ): Promise<boolean>;

  removeSpeaker(name: string): Promise<boolean>;
  listSpeakers(): Promise<string[]>;
  contains(name: string): Promise<boolean>;
  numSpeakers(): Promise<number>;
  destroy(): Promise<void>;
}
