import type {
  OfflineAudioBufferRef,
  LiveAudioBufferRef,
  OfflineBufferHandle,
  LiveBufferHandle,
  PipelineAudioDeviceInfo,
} from '../audiobuffer/types';

/** Reference or handle to an audio buffer (offline or live). */
export type PcmPlayerAudioBuffer =
  | OfflineAudioBufferRef
  | LiveAudioBufferRef
  | OfflineBufferHandle
  | LiveBufferHandle
  | string;

/** Event payload emitted when playback reaches end-of-stream. */
export interface PcmPlayerEndedEvent {
  playerId: string;
  bufferId: string;
}

/** Options for creating a pipeline-based PCM player. */
export interface PcmPlayerOptions {
  /** Optional volume scale [0, 1]. Default: 1.0. */
  volume?: number;
  /**
   * Optional preferred output device id from listAvailableOutputDevices().
   * Best effort: playback still starts if the route cannot be switched.
   */
  outputDeviceId?: string;
  /** Callback fired when playback reaches end-of-stream. Fires once per playback run. */
  onEnded?: (event: PcmPlayerEndedEvent) => void;
}

/** Device metadata returned by listAvailableOutputDevices(). */
export type PcmOutputDeviceInfo = PipelineAudioDeviceInfo;

/** Pipeline audio buffer player session. */
export interface PcmPlayer {
  /** Unique player session ID (generated at creation). */
  readonly playerId: string;

  /** Pause playback. Buffered samples are retained — resume() continues from current position. */
  pause(): Promise<void>;

  /** Resume paused playback. No-op if not paused. */
  resume(): Promise<void>;

  /**
   * Seek to a position in milliseconds.
   * - Offline buffers: clamps to [0, durationMs].
   * - Live buffers (recording): rejects with PCM_PLAYER_SEEK_OUT_OF_RANGE if outside available ring window.
   * - Live buffers (finished): seeks within available data.
   */
  seekToMs(positionMs: number): Promise<void>;

  /** Restart playback from the beginning. Equivalent to seekToMs(0) + resume if ended. */
  restart(): Promise<void>;

  /** Get the current playback position in milliseconds. */
  getPlaybackPositionMs(): Promise<number>;

  /**
   * Stop playback and release native resources.
   * After this call the player is invalid — do not call other methods.
   */
  destroy(): Promise<void>;
}
