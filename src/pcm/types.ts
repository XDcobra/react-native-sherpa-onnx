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

/** Event payload emitted when playback reaches end-of-stream. */
export interface PcmPlayerEndedEvent {
  playerId: string;
  bufferId: string;
}

/** Native playhead push while the player is actively playing. */
export interface PcmPlayerPositionEvent {
  playerId: string;
  bufferId: string;
  positionMs: number;
}

/** Options for creating a pipeline-based PCM player. */
export interface PcmPlayerOptions {
  /** Optional volume scale [0, 1]. Default: 1.0. */
  volume?: number;
  /** Callback fired when playback reaches end-of-stream. Fires once per playback run. */
  onEnded?: (event: PcmPlayerEndedEvent) => void;
  /**
   * Native playhead updates while playing (no JS polling).
   * Emitted from the native PCM session on a ~50ms cadence while PLAYING.
   */
  onPosition?: (event: PcmPlayerPositionEvent) => void;
}

/** Pipeline audio buffer player session. */
export interface PcmPlayer {
  /** Unique player session ID (generated at creation). */
  readonly playerId: string;

  /**
   * Pause playback. Buffered samples are retained — resume() continues from current position.
   * @throws {Error} `PCM_PLAYER_NOT_FOUND` — player id is unknown.
   * @throws {Error} `PCM_PLAYER_DESTROYED` — player was already destroyed.
   * @throws {Error} `PCM_PLAYER_ERROR` — native pause failed.
   */
  pause(): Promise<void>;

  /**
   * Resume paused playback. No-op if not paused.
   * @throws {Error} `PCM_PLAYER_NOT_FOUND` — player id is unknown.
   * @throws {Error} `PCM_PLAYER_DESTROYED` — player was already destroyed.
   * @throws {Error} `PCM_PLAYER_ERROR` — native resume failed.
   */
  resume(): Promise<void>;

  /**
   * Seek to a position in milliseconds.
   * - Offline buffers: clamps to [0, durationMs].
   * - Live buffers (recording): rejects with PCM_PLAYER_SEEK_OUT_OF_RANGE if outside available ring window.
   * - Live buffers (finished): seeks within available data.
   * Preserves pause/play intent (seek while paused stays paused).
   * @throws {Error} `PCM_PLAYER_SEEK_OUT_OF_RANGE` — live seek is outside the available ring window.
   * @throws {Error} `PCM_PLAYER_NOT_FOUND` — player id is unknown.
   * @throws {Error} `PCM_PLAYER_DESTROYED` — player was already destroyed.
   * @throws {Error} `PCM_PLAYER_ERROR` — native seek failed.
   */
  seekToMs(positionMs: number): Promise<void>;

  /**
   * Restart playback from the beginning. Equivalent to seekToMs(0) + resume if ended.
   * @throws {Error} `PCM_PLAYER_NOT_FOUND` — player id is unknown.
   * @throws {Error} `PCM_PLAYER_DESTROYED` — player was already destroyed.
   * @throws {Error} `PCM_PLAYER_ERROR` — native restart failed.
   */
  restart(): Promise<void>;

  /**
   * Get the current playback position in milliseconds (pull). Prefer `onPosition` for UI.
   * @throws {Error} `PCM_PLAYER_NOT_FOUND` — player id is unknown.
   * @throws {Error} `PCM_PLAYER_DESTROYED` — player was already destroyed.
   * @throws {Error} `PCM_PLAYER_ERROR` — native position read failed.
   */
  getPlaybackPositionMs(): Promise<number>;

  /**
   * Stop playback and release native resources.
   * After this call the player is invalid — do not call other methods.
   * Idempotent in JS; typically does not throw.
   */
  destroy(): Promise<void>;
}
