import { NativeEventEmitter, NativeModules } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  PcmPlayer,
  PcmPlayerOptions,
  PcmPlayerAudioBuffer,
} from './types';
import { resolvePipelineAudioBufferId } from '../audiobuffer/index';

let pcmPlayerCounter = 0;

let eventEmitter: NativeEventEmitter | null = null;
function getEventEmitter(): NativeEventEmitter {
  if (!eventEmitter) {
    const nativeModule = NativeModules.SherpaOnnx as
      | {
          addListener?: (eventName: string) => void;
          removeListeners?: (count: number) => void;
        }
      | undefined;
    const supportsNativeEmitter =
      typeof nativeModule?.addListener === 'function' &&
      typeof nativeModule?.removeListeners === 'function';
    eventEmitter = new NativeEventEmitter(
      supportsNativeEmitter ? (nativeModule as any) : null
    );
  }
  return eventEmitter;
}

/**
 * Create a pipeline audio buffer player session for mono float audio playback.
 *
 * The player consumes audio frames from a pipeline buffer (offline or live)
 * and plays them via native audio backend (AudioTrack on Android, AVAudioEngine on iOS).
 *
 * @param audioBuffer - Live or offline audio buffer to play from
 * @param options - Player configuration (volume, onEnded, etc.)
 * @returns Promise resolving to a PcmPlayer handle
 */
export async function createPcmPlayer(
  audioBuffer: PcmPlayerAudioBuffer,
  options?: PcmPlayerOptions
): Promise<PcmPlayer> {
  const playerId = `pcm_player_${++pcmPlayerCounter}`;
  const bufferId = resolvePipelineAudioBufferId(audioBuffer);
  const volume = options?.volume ?? 1.0;

  // Subscribe to ended event before creating the player to avoid race conditions
  let endedSubscription: ReturnType<NativeEventEmitter['addListener']> | null =
    null;
  if (options?.onEnded) {
    const onEnded = options.onEnded;
    endedSubscription = getEventEmitter().addListener('pcmPlayerEnded', ((
      rawEvent: unknown
    ) => {
      const event = rawEvent as { playerId: string; bufferId: string };
      if (event.playerId === playerId) {
        onEnded({ playerId: event.playerId, bufferId: event.bufferId });
      }
    }) as any);
  }

  try {
    await SherpaOnnx.createPcmPlayer(playerId, bufferId, volume);
  } catch (e) {
    endedSubscription?.remove();
    throw e;
  }

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

    async seekToMs(positionMs: number): Promise<void> {
      guard();
      return SherpaOnnx.seekPcmPlayerToMs(playerId, positionMs);
    },

    async restart(): Promise<void> {
      guard();
      return SherpaOnnx.restartPcmPlayer(playerId);
    },

    async getPlaybackPositionMs(): Promise<number> {
      guard();
      return SherpaOnnx.getPcmPlayerPositionMs(playerId);
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      endedSubscription?.remove();
      endedSubscription = null;
      await SherpaOnnx.destroyPcmPlayer(playerId);
    },
  };
}
