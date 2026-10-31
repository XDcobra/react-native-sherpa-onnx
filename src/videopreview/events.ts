import { NativeEventEmitter, NativeModules } from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import { TurboModuleRegistry } from 'react-native';
import type { VideoPreviewEvent, VideoPreviewEventType } from './types';

const NativeSherpaOnnx = TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');
const emitter = new NativeEventEmitter(
  NativeModules.SherpaOnnx ?? (NativeSherpaOnnx as never)
);

export type NativeVideoPreviewEvent = {
  playerId: string;
  type: string;
  payload?: Record<string, unknown> | string;
  liveBufferId?: string;
};

function parsePayload(raw: NativeVideoPreviewEvent): Record<string, unknown> {
  const p = raw.payload as unknown;
  if (typeof p === 'string') {
    try {
      const parsed = JSON.parse(p) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn('[SherpaOnnx:video.preview] dropped malformed payload');
      }
      return {};
    }
  }
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    return p as Record<string, unknown>;
  }
  return {};
}

function mapNative(raw: NativeVideoPreviewEvent): VideoPreviewEvent | null {
  if (!raw || typeof raw.type !== 'string') {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[SherpaOnnx:video.preview] dropped unknown event');
    }
    return null;
  }
  const p = parsePayload(raw);
  switch (raw.type) {
    case 'stateChanged':
      return {
        type: 'stateChanged',
        state: String(p.state) as VideoPreviewEvent extends {
          type: 'stateChanged';
          state: infer S;
        }
          ? S
          : never,
        previousState: String(p.previousState) as never,
        positionMs: Number(p.positionMs ?? 0),
      };
    case 'progress':
      return {
        type: 'progress',
        positionMs: Number(p.positionMs ?? 0),
        seekableRange: {
          startMs: Number(
            (p.seekableRange as { startMs?: number } | undefined)?.startMs ?? 0
          ),
          endMs: Number(
            (p.seekableRange as { endMs?: number } | undefined)?.endMs ?? 0
          ),
        },
        liveEdgeMs: p.liveEdgeMs == null ? null : Number(p.liveEdgeMs),
        nativeTimestampMs: Number(p.nativeTimestampMs ?? 0),
      };
    case 'firstFrameRendered':
      return {
        type: 'firstFrameRendered',
        positionMs: Number(p.positionMs ?? 0),
      };
    case 'seekCompleted':
      return {
        type: 'seekCompleted',
        result: p.result as never,
        mode: (p.mode as never) ?? 'exact',
      };
    case 'seekClamped':
      return {
        type: 'seekClamped',
        requestedMs: Number(p.requestedMs ?? 0),
        actualMs: Number(p.actualMs ?? 0),
        reason: (p.reason as never) ?? 'beforeStart',
      };
    case 'positionEvicted':
      return {
        type: 'positionEvicted',
        previousMs: Number(p.previousMs ?? 0),
        newMs: Number(p.newMs ?? 0),
      };
    case 'liveEdgeResync':
      return {
        type: 'liveEdgeResync',
        lagMs: Number(p.lagMs ?? 0),
        newMs: Number(p.newMs ?? 0),
      };
    case 'audioUnavailable':
      return {
        type: 'audioUnavailable',
        reason: (p.reason as never) ?? 'absent',
        code: (p.code as never) ?? 'VIDEO_NO_AUDIO_TRACK',
        message: String(p.message ?? ''),
        codec: p.codec == null ? null : String(p.codec),
        atMs: Number(p.atMs ?? 0),
        videoContinues: true,
      };
    case 'audioInterrupted':
      return {
        type: 'audioInterrupted',
        reason: (p.reason as never) ?? 'focusLoss',
      };
    case 'ended':
      return { type: 'ended' };
    case 'error':
      return {
        type: 'error',
        code: (p.code as never) ?? 'VIDEO_PREVIEW_INVALID_STATE',
        message: String(p.message ?? ''),
      };
    default:
      return null;
  }
}

type Listener = (e: VideoPreviewEvent) => void;

const perPlayer = new Map<string, Set<Listener>>();
let subscription: { remove(): void } | null = null;

function ensure(): void {
  if (subscription) {
    return;
  }
  subscription = emitter.addListener('SherpaOnnxVideoPreviewEvent', (raw) => {
    const event = raw as NativeVideoPreviewEvent;
    const mapped = mapNative(event);
    if (!mapped) {
      return;
    }
    const pid =
      event.playerId ||
      String((event as { liveBufferId?: string }).liveBufferId ?? '');
    const set = perPlayer.get(pid);
    if (!set) {
      return;
    }
    for (const fn of set) {
      fn(mapped);
    }
  });
}

export function addPlayerListener(
  playerId: string,
  listener: Listener
): () => void {
  ensure();
  let set = perPlayer.get(playerId);
  if (!set) {
    set = new Set();
    perPlayer.set(playerId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) {
      perPlayer.delete(playerId);
    }
  };
}

export function addTypedListener<T extends VideoPreviewEventType>(
  playerId: string,
  type: T,
  listener: (e: Extract<VideoPreviewEvent, { type: T }>) => void
): () => void {
  return addPlayerListener(playerId, (e) => {
    if (e.type === type) {
      listener(e as Extract<VideoPreviewEvent, { type: T }>);
    }
  });
}

/** JS-thread events (command results). Native events can lag if the JS queue is busy. */
export function emitLocalPreviewEvent(
  playerId: string,
  event: VideoPreviewEvent
): void {
  const set = perPlayer.get(playerId);
  if (!set) {
    return;
  }
  for (const fn of set) {
    fn(event);
  }
}

export function __resetVideoPreviewEventsForTests(): void {
  perPlayer.clear();
  subscription?.remove();
  subscription = null;
}

export { mapNative };
