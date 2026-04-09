import SherpaOnnx from '../NativeSherpaOnnx';
import type { PcmPlayer, PcmPlayerOptions, PcmPlayerFeed } from './types';

let pcmPlayerCounter = 0;

/**
 * Create a standalone PCM player session for mono float audio playback.
 *
 * @param options - Player configuration (sampleRate, feed mode, optional TTS binding)
 * @returns Promise resolving to a PcmPlayer handle
 */
export async function createPcmPlayer(
  options: PcmPlayerOptions
): Promise<PcmPlayer> {
  const playerId = `pcm_player_${++pcmPlayerCounter}`;
  const feed: PcmPlayerFeed = options.feed ?? 'js';
  const channels = options.channels ?? 1;

  await SherpaOnnx.createPcmPlayer(
    playerId,
    options.sampleRate,
    channels,
    feed,
    options.ttsInstanceId ?? null
  );

  let destroyed = false;
  const guard = () => {
    if (destroyed) throw new Error(`PcmPlayer ${playerId} has been destroyed`);
  };

  return {
    get playerId() {
      return playerId;
    },
    get feed() {
      return feed;
    },

    async writePcmChunk(samples: Float32Array | number[]): Promise<void> {
      guard();
      if (feed === 'native') {
        throw new Error(
          `PcmPlayer ${playerId} has feed 'native'; writePcmChunk() is not allowed from JS. ` +
            `Use feed 'js' for manual PCM writes.`
        );
      }
      const arr =
        samples instanceof Float32Array ? Array.from(samples) : samples;
      return SherpaOnnx.writePcmChunk(playerId, arr);
    },

    async pause(): Promise<void> {
      guard();
      return SherpaOnnx.pausePcmPlayer(playerId);
    },

    async resume(): Promise<void> {
      guard();
      return SherpaOnnx.resumePcmPlayer(playerId);
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.destroyPcmPlayer(playerId);
    },
  };
}
