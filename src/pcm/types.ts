/**
 * How PCM data is fed to the player.
 * - 'js': accepts samples via writePcmChunk() from JavaScript.
 * - 'native': only native producers (TTS streaming playback, batch sink) may enqueue.
 *   Calling writePcmChunk() on a 'native' feed player rejects with an error.
 */
export type PcmPlayerFeed = 'js' | 'native';

/** Options for creating a standalone PCM player. */
export interface PcmPlayerOptions {
  /** Sample rate in Hz (e.g. 22050, 24000). */
  sampleRate: number;
  /** Number of audio channels. Only 1 (mono) is supported in v1. */
  channels?: number;
  /**
   * How PCM data reaches this player.
   * - 'js' (default): app feeds samples via writePcmChunk().
   * - 'native': only native producers may enqueue; writePcmChunk() is rejected.
   */
  feed?: PcmPlayerFeed;
  /**
   * Optional TTS engine instance ID to bind this player to.
   * When set, the native layer enforces mutex rules with streaming playback.
   * When omitted, the player is fully standalone (e.g. mic PCM, test PCM).
   */
  ttsInstanceId?: string;
}

/** Standalone PCM player session. */
export interface PcmPlayer {
  /** Unique player session ID (generated at creation). */
  readonly playerId: string;
  /** The feed mode this player was created with. */
  readonly feed: PcmPlayerFeed;

  /**
   * Write float PCM samples [-1, 1] to the player queue.
   * Only valid when feed is 'js'. Rejects when feed is 'native'.
   */
  writePcmChunk(samples: Float32Array | number[]): Promise<void>;

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
