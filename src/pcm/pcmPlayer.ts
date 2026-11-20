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

function invalidConfig(message: string): Error {
  return Object.assign(new Error(`PCM_PLAYER_INVALID_CONFIG: ${message}`), {
    code: 'PCM_PLAYER_INVALID_CONFIG',
  });
}

/**
 * Validate `startMs` / `autoplay` and map them to the native arguments.
 * A missing `startMs` becomes `-1` ("not set"), so native keeps its default
 * start position (0 for offline buffers, the cursor default for live ones).
 */
function resolveStartOptions(options?: PcmPlayerOptions): {
  startMs: number;
  autoplay: boolean;
} {
  const startMs = options?.startMs;
  if (startMs !== undefined) {
    if (typeof startMs !== 'number' || !Number.isFinite(startMs)) {
      throw invalidConfig('startMs must be a finite number');
    }
    if (startMs < 0) {
      throw invalidConfig('startMs must be >= 0');
    }
  }
  const autoplay = options?.autoplay;
  if (autoplay !== undefined && typeof autoplay !== 'boolean') {
    throw invalidConfig('autoplay must be a boolean');
  }
  return { startMs: startMs ?? -1, autoplay: autoplay ?? true };
}

/**
 * Create a pipeline audio buffer player session for mono float audio playback.
 *
 * The player consumes audio frames from a pipeline buffer (offline or live)
 * and plays them via native audio backend (AudioTrack on Android, AVAudioEngine on iOS).
 *
 * By default playback starts at once from the start of the buffer. Pass
 * `startMs` to start at a later position (nothing before it is heard) and
 * `autoplay: false` to create the player paused there; `resume()` starts it.
 *
 * @param audioBuffer - Live or offline audio buffer to play from
 * @param options - Player configuration (volume, startMs, autoplay, onEnded, onPosition)
 * @returns Promise resolving to a PcmPlayer handle
 * @throws {Error} `AUDIO_INVALID_ARGUMENT` — audio buffer id is malformed.
 * @throws {Error} `AUDIO_BUFFER_NOT_FOUND` — buffer is not in the native registry.
 * @throws {Error} `PCM_PLAYER_INVALID_CONFIG` — player config or backend setup is invalid
 *   (also: `startMs` is negative or not finite, `autoplay` is not a boolean).
 * @throws {Error} `PCM_PLAYER_ERROR` — native player create failed.
 */
export async function createPcmPlayer(
  audioBuffer: PcmPlayerAudioBuffer,
  options?: PcmPlayerOptions
): Promise<PcmPlayer> {
  const playerId = `pcm_player_${++pcmPlayerCounter}`;
  const bufferId = resolvePipelineAudioBufferId(audioBuffer);
  const volume = options?.volume ?? 1.0;
  const { startMs, autoplay } = resolveStartOptions(options);

  // Subscribe before create to avoid missing the first events.
  let endedSubscription: ReturnType<NativeEventEmitter['addListener']> | null =
    null;
  let positionSubscription: ReturnType<
    NativeEventEmitter['addListener']
  > | null = null;

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

  if (options?.onPosition) {
    const onPosition = options.onPosition;
    positionSubscription = getEventEmitter().addListener('pcmPlayerPosition', ((
      rawEvent: unknown
    ) => {
      const event = rawEvent as {
        playerId: string;
        bufferId: string;
        positionMs: number;
      };
      if (event.playerId === playerId) {
        onPosition({
          playerId: event.playerId,
          bufferId: event.bufferId,
          positionMs: event.positionMs,
        });
      }
    }) as any);
  }

  try {
    await SherpaOnnx.createPcmPlayer(
      playerId,
      bufferId,
      volume,
      startMs,
      autoplay
    );
  } catch (e) {
    endedSubscription?.remove();
    positionSubscription?.remove();
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
      positionSubscription?.remove();
      positionSubscription = null;
      await SherpaOnnx.destroyPcmPlayer(playerId);
    },
  };
}
