import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  PcmPlayer,
  PcmPlayerOptions,
  PcmPlayerAudioBuffer,
} from './types';
import { resolvePipelineAudioBufferId } from '../audiobuffer/index';

let pcmPlayerCounter = 0;

/**
 * Create a pipeline audio buffer player session for mono float audio playback.
 *
 * The player consumes audio frames from a pipeline buffer (offline or live)
 * and plays them via native audio backend (AudioTrack on Android, AVAudioEngine on iOS).
 *
 * @param audioBuffer - Live or offline audio buffer to play from
 * @param options - Player configuration (volume, etc.)
 * @returns Promise resolving to a PcmPlayer handle
 */
export async function createPcmPlayer(
  audioBuffer: PcmPlayerAudioBuffer,
  options?: PcmPlayerOptions
): Promise<PcmPlayer> {
  const playerId = `pcm_player_${++pcmPlayerCounter}`;
  const bufferId = resolvePipelineAudioBufferId(audioBuffer);
  const volume = options?.volume ?? 1.0;

  await SherpaOnnx.createPcmPlayer(playerId, bufferId, volume);

  let destroyed = false;
  const guard = () => {
    if (destroyed) throw new Error(`PcmPlayer ${playerId} has been destroyed`);
  };

  return {
    get playerId() {
      return playerId;
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
