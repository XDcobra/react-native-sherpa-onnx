import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type { OfflineSegmentBufferIdSource } from '../segmentbuffer/types';
import type { OrchestrationProgress } from '../pipeline/offlineOrchestrator';
import type { SpeakerEmbeddingInitializeOptions } from '../speaker-embedding/types';

export type { OrchestrationProgress };

export type SpeakerIdentificationOptions = SpeakerEmbeddingInitializeOptions;

export type IdentifyResult = {
  /** Matched enrolled speaker name, or `null` when below threshold / unknown. */
  name: string | null;
};

export type LabelOfflineSegmentsResult = {
  labeledCount: number;
  unknownCount: number;
};

export type SpeakerIdentificationThresholdOptions = {
  /** Cosine similarity threshold in `[0, 1]`. Default `0.5`. */
  threshold?: number;
};

/** Shared by enrollOfflineSegments + label (progress only). */
export type SpeakerIdentificationSegmentOptions =
  SpeakerIdentificationThresholdOptions & {
    /** Coarse start-of-step progress for multi-span enroll/label loops. */
    onProgress?: (progress: OrchestrationProgress) => void;
  };

/** Fired after a speech span is searched and staged during `labelOfflineSegments`. */
export type SidLabeledSegmentEvent = {
  segmentIndex: number;
  totalSegments: number;
  startSample: number;
  endSample: number;
  sampleRate: number;
  durationMs: number;
  /** Matched enrolled name, or null when below threshold / unknown. */
  speakerName: string | null;
};

/** Options for `labelOfflineSegments` only. */
export type SpeakerIdentificationLabelOptions =
  SpeakerIdentificationSegmentOptions & {
    onLabeled?: (event: SidLabeledSegmentEvent) => void;
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

  /**
   * Enroll a named speaker from speech spans in an offline segment buffer.
   * All non-empty speech ranges are extracted and averaged under `name`.
   */
  enrollOfflineSegments(
    name: string,
    audioIn: OfflineAudioBufferIdSource,
    segmentsIn: OfflineSegmentBufferIdSource,
    options?: SpeakerIdentificationSegmentOptions
  ): Promise<void>;

  identify(
    audio: OfflineAudioBufferIdSource,
    options?: SpeakerIdentificationThresholdOptions
  ): Promise<IdentifyResult>;

  /**
   * Identify each speech span and write a labeled copy into an empty
   * `segmentsOut` buffer (`payload.source: 'sid'`).
   */
  labelOfflineSegments(
    audioIn: OfflineAudioBufferIdSource,
    segmentsIn: OfflineSegmentBufferIdSource,
    segmentsOut: OfflineSegmentBufferIdSource,
    options?: SpeakerIdentificationLabelOptions
  ): Promise<LabelOfflineSegmentsResult>;

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
