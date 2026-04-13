import type {
  OfflineAudioBufferRef,
  LiveAudioBufferRef,
  OfflineBufferHandle,
  LiveBufferHandle,
} from '../audiobuffer/types';

/** Reference or handle to an audio buffer (offline or live). */
export type PcmPlayerAudioBuffer =
  | OfflineAudioBufferRef
  | LiveAudioBufferRef
  | OfflineBufferHandle
  | LiveBufferHandle
  | string;

/** Options for creating a pipeline-based PCM player. */
export interface PcmPlayerOptions {
  /** Optional volume scale [0, 1]. Default: 1.0. */
  volume?: number;
}

/** Pipeline audio buffer player session. */
export interface PcmPlayer {
  /** Unique player session ID (generated at creation). */
  readonly playerId: string;

  /** Pause playback. Buffered samples are retained — resume() continues from current position. */
  pause(): Promise<void>;

  /** Resume paused playback. No-op if not paused. */
  resume(): Promise<void>;

  /**
   * Stop playback and release native resources.
   * After this call the player is invalid — do not call other methods.
   */
  destroy(): Promise<void>;
}
