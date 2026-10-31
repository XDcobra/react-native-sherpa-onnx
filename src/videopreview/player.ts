import { TurboModuleRegistry } from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import type {
  PipelineVideoBufferIdSource,
  PipelineVideoBufferKind,
} from '../videobuffer/types';
import { resolvePipelineVideoBufferId } from '../videobuffer';
import { addTypedListener, emitLocalPreviewEvent } from './events';
import type {
  VideoPreviewEventOf,
  VideoPreviewEventType,
  VideoPreviewPlayer,
  VideoPreviewPlayerOptions,
  VideoPreviewSeekResult,
  VideoPreviewSnapshot,
} from './types';
import { VideoPreviewError, VideoPreviewErrorCode } from './types';
import {
  asVideoPreviewPlayerId,
  nativeErrorToPreview,
  validateCreateOptions,
  validateSeekMs,
  validateVolume,
} from './validate';

const NativeSherpaOnnx = TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `vprev_req_${requestSeq}`;
}

function parseSnapshot(raw: Record<string, unknown>): VideoPreviewSnapshot {
  return {
    playerId: asVideoPreviewPlayerId(String(raw.playerId ?? '')),
    bufferId: String(raw.bufferId ?? ''),
    bufferKind: (raw.bufferKind as PipelineVideoBufferKind) ?? 'offline',
    state: (raw.state as VideoPreviewSnapshot['state']) ?? 'idle',
    positionMs: Number(raw.positionMs ?? 0),
    durationMs: raw.durationMs == null ? null : Number(raw.durationMs),
    seekableRange: {
      startMs: Number(
        (raw.seekableRange as { startMs?: number } | undefined)?.startMs ?? 0
      ),
      endMs: Number(
        (raw.seekableRange as { endMs?: number } | undefined)?.endMs ?? 0
      ),
    },
    liveEdgeMs: raw.liveEdgeMs == null ? null : Number(raw.liveEdgeMs),
    atLiveEdge: Boolean(raw.atLiveEdge),
    playbackRate: 1,
    videoAttached: Boolean(raw.videoAttached),
    audio: (raw.audio as VideoPreviewSnapshot['audio']) ?? { status: 'off' },
    stats: {
      framesRendered: Number(
        (raw.stats as { framesRendered?: number } | undefined)
          ?.framesRendered ?? 0
      ),
      framesDropped: Number(
        (raw.stats as { framesDropped?: number } | undefined)?.framesDropped ??
          0
      ),
      audioUnderruns: Number(
        (raw.stats as { audioUnderruns?: number } | undefined)
          ?.audioUnderruns ?? 0
      ),
      avOffsetMs: Number(
        (raw.stats as { avOffsetMs?: number } | undefined)?.avOffsetMs ?? 0
      ),
    },
  };
}

function wrapPlayer(
  snapshot: VideoPreviewSnapshot,
  options: VideoPreviewPlayerOptions | undefined
): VideoPreviewPlayer {
  let released = false;
  const id = snapshot.playerId;
  let lastState = snapshot.state;
  let loopEnabled = options?.loop === true;
  let lastLoopReplayMs = 0;

  const snapshotFromCommand = async (
    raw: unknown
  ): Promise<VideoPreviewSnapshot> => {
    if (raw && typeof raw === 'object' && 'state' in (raw as object)) {
      return parseSnapshot(raw as Record<string, unknown>);
    }
    return parseSnapshot(
      (await NativeSherpaOnnx.videoPreviewSnapshot(id)) as Record<
        string,
        unknown
      >
    );
  };

  const publishSnapshot = async (
    _reason: string,
    raw?: unknown
  ): Promise<void> => {
    const s = await snapshotFromCommand(raw);
    const previousState = lastState;
    lastState = s.state;
    emitLocalPreviewEvent(id, {
      type: 'stateChanged',
      state: s.state,
      previousState,
      positionMs: s.positionMs,
    });
    emitLocalPreviewEvent(id, {
      type: 'progress',
      positionMs: s.positionMs,
      seekableRange: s.seekableRange,
      liveEdgeMs: s.liveEdgeMs,
      nativeTimestampMs: Date.now(),
    });
  };

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (released) {
      throw new VideoPreviewError(
        VideoPreviewErrorCode.VIDEO_PREVIEW_RELEASED,
        'player released'
      );
    }
    try {
      return await fn();
    } catch (e) {
      const err = nativeErrorToPreview(e);
      options?.onError?.(err);
      throw err;
    }
  };

  const player: VideoPreviewPlayer = {
    playerId: id,
    bufferId: snapshot.bufferId,
    initialSnapshot: snapshot,
    play: () =>
      guard(async () => {
        const r = await NativeSherpaOnnx.videoPreviewPlay(id, nextRequestId());
        await publishSnapshot('play', r as unknown);
        return r;
      }),
    pause: () =>
      guard(async () => {
        const r = await NativeSherpaOnnx.videoPreviewPause(id, nextRequestId());
        await publishSnapshot('pause', r as unknown);
        return r;
      }),
    seekTo: (positionMs, opts) => {
      validateSeekMs(positionMs);
      return guard(async () => {
        const r = (await NativeSherpaOnnx.videoPreviewSeek(
          id,
          positionMs,
          opts?.mode ?? 'exact',
          false,
          nextRequestId()
        )) as VideoPreviewSeekResult;
        await publishSnapshot('seekTo');
        return r;
      });
    },
    seekBy: (deltaMs, opts) => {
      validateSeekMs(deltaMs);
      return guard(async () => {
        const r = (await NativeSherpaOnnx.videoPreviewSeek(
          id,
          deltaMs,
          opts?.mode ?? 'exact',
          true,
          nextRequestId()
        )) as VideoPreviewSeekResult;
        await publishSnapshot('seekBy');
        return r;
      });
    },
    seekToLiveEdge: () =>
      guard(async () => {
        const r = (await NativeSherpaOnnx.videoPreviewSeekToLiveEdge(
          id,
          nextRequestId()
        )) as VideoPreviewSeekResult;
        await publishSnapshot('seekToLiveEdge');
        return r;
      }),
    stepFrame: (direction) => {
      if (direction !== 1 && direction !== -1) {
        return Promise.reject(
          new VideoPreviewError(
            VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_ARGUMENT,
            'direction must be 1 or -1'
          )
        );
      }
      return guard(async () => {
        const r = (await NativeSherpaOnnx.videoPreviewStepFrame(
          id,
          direction,
          nextRequestId()
        )) as VideoPreviewSeekResult;
        await publishSnapshot('stepFrame');
        return r;
      });
    },
    setVolume: (volume) => {
      validateVolume(volume);
      return guard(() => NativeSherpaOnnx.videoPreviewSetVolume(id, volume));
    },
    setMuted: (muted) =>
      guard(() => NativeSherpaOnnx.videoPreviewSetMuted(id, muted)),
    setLoop: (loop) =>
      guard(async () => {
        loopEnabled = loop;
        await NativeSherpaOnnx.videoPreviewSetLoop(id, loop);
        if (loop && lastState === 'ended') {
          lastLoopReplayMs = Date.now();
          await NativeSherpaOnnx.videoPreviewPlay(id, nextRequestId());
          await publishSnapshot('loop_replay_from_setLoop');
        }
      }),
    getSnapshot: () =>
      guard(async () =>
        parseSnapshot(
          (await NativeSherpaOnnx.videoPreviewSnapshot(id)) as Record<
            string,
            unknown
          >
        )
      ),
    addListener: <T extends VideoPreviewEventType>(
      type: T,
      listener: (e: VideoPreviewEventOf<T>) => void
    ) => {
      const off = addTypedListener(id, type, listener);
      if (type === 'audioUnavailable' && options?.onAudioUnavailable) {
        const extra = addTypedListener(id, 'audioUnavailable', (e) => {
          options.onAudioUnavailable?.(e);
        });
        return () => {
          off();
          extra();
        };
      }
      return off;
    },
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      offEnded();
      await NativeSherpaOnnx.releaseVideoPreviewPlayer(id);
    },
  };

  if (options?.onAudioUnavailable) {
    addTypedListener(id, 'audioUnavailable', options.onAudioUnavailable);
  }
  if (options?.onError) {
    addTypedListener(id, 'error', (e) => {
      options.onError?.(new VideoPreviewError(e.code, e.message));
    });
  }
  const offEnded = addTypedListener(id, 'ended', () => {
    lastState = 'ended';
    const now = Date.now();
    const tooSoon = now - lastLoopReplayMs < 400;
    if (!loopEnabled || released || tooSoon) {
      return;
    }
    lastLoopReplayMs = now;
    player.play().catch(() => undefined);
  });
  return player;
}

export async function createVideoPreviewPlayer(
  source: PipelineVideoBufferIdSource,
  options?: VideoPreviewPlayerOptions
): Promise<VideoPreviewPlayer> {
  let bufferId: string;
  try {
    bufferId = resolvePipelineVideoBufferId(source);
  } catch (e) {
    throw new VideoPreviewError(
      VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_ARGUMENT,
      e instanceof Error ? e.message : 'bufferId required',
      e
    );
  }
  validateCreateOptions(options);
  try {
    const raw = (await NativeSherpaOnnx.createVideoPreviewPlayer(bufferId, {
      audio: options?.audio ?? { source: 'track', required: false },
      startAtMs: options?.startAtMs,
      live: options?.live,
      volume: options?.volume ?? 1,
      muted: options?.muted ?? false,
      loop: options?.loop ?? false,
      pauseOnBackground: options?.pauseOnBackground ?? true,
      progressIntervalMs: options?.progressIntervalMs ?? 250,
    })) as Record<string, unknown>;
    if (raw.errorCode) {
      throw new VideoPreviewError(
        String(raw.errorCode) as never,
        String(raw.message ?? raw.errorCode)
      );
    }
    const player = wrapPlayer(parseSnapshot(raw), options);
    if (
      player.initialSnapshot.audio.status === 'unavailable' &&
      options?.onAudioUnavailable
    ) {
      const a = player.initialSnapshot.audio;
      options.onAudioUnavailable({
        type: 'audioUnavailable',
        reason: a.reason,
        code: a.code,
        message: a.code,
        codec: a.codec,
        atMs: player.initialSnapshot.positionMs,
        videoContinues: true,
      });
    }
    return player;
  } catch (e) {
    throw nativeErrorToPreview(e);
  }
}
