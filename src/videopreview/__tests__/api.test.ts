jest.mock('../../videobuffer', () => ({
  resolvePipelineVideoBufferId: (source: unknown) => {
    if (typeof source === 'string') return source;
    const s = source as { bufferId?: string };
    if (s?.bufferId) return s.bufferId;
    throw new Error('VIDEO_INVALID_ARGUMENT: malformed video buffer id');
  },
}));

jest.mock('react-native', () => {
  const listeners: Array<(event: unknown) => void> = [];
  const mockNative = {
    createVideoPreviewPlayer: jest.fn(),
    videoPreviewPlay: jest.fn(async () => undefined),
    videoPreviewPause: jest.fn(async () => undefined),
    videoPreviewSeek: jest.fn(async () => ({
      status: 'completed',
      requestedMs: 0,
      actualMs: 0,
    })),
    videoPreviewSeekToLiveEdge: jest.fn(async () => ({
      status: 'completed',
      requestedMs: 0,
      actualMs: 0,
    })),
    videoPreviewStepFrame: jest.fn(async () => ({
      status: 'completed',
      requestedMs: 0,
      actualMs: 0,
    })),
    videoPreviewSetVolume: jest.fn(async () => undefined),
    videoPreviewSetMuted: jest.fn(async () => undefined),
    videoPreviewSetLoop: jest.fn(async () => undefined),
    videoPreviewSnapshot: jest.fn(),
    releaseVideoPreviewPlayer: jest.fn(async () => undefined),
  };
  return {
    NativeModules: { SherpaOnnx: {} },
    NativeEventEmitter: class {
      addListener(_event: string, cb: (event: unknown) => void) {
        listeners.push(cb);
        return {
          remove: () => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          },
        };
      }
    },
    TurboModuleRegistry: { getEnforcing: () => mockNative },
    Platform: { OS: 'ios' },
    requireNativeComponent: () => 'View',
    View: 'View',
    __mockNative: mockNative,
    __emit: (e: unknown) => {
      for (const cb of listeners) cb(e);
    },
  };
});

import {
  createVideoPreviewPlayer,
  VideoPreviewError,
  VideoPreviewErrorCode,
} from '../index';
import { mapNative } from '../events';

const rn = jest.requireMock('react-native') as {
  __mockNative: {
    createVideoPreviewPlayer: jest.Mock;
    videoPreviewPlay: jest.Mock;
    videoPreviewPause: jest.Mock;
    videoPreviewSeek: jest.Mock;
    videoPreviewSeekToLiveEdge: jest.Mock;
    videoPreviewStepFrame: jest.Mock;
    videoPreviewSetVolume: jest.Mock;
    videoPreviewSetMuted: jest.Mock;
    videoPreviewSetLoop: jest.Mock;
    videoPreviewSnapshot: jest.Mock;
    releaseVideoPreviewPlayer: jest.Mock;
  };
};
const mockNative = rn.__mockNative;

const OFF = 'vid_off_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function snapshot(over: Record<string, unknown> = {}) {
  return {
    playerId: 'vprev_1',
    bufferId: OFF,
    bufferKind: 'offlineVideoBuffer',
    state: 'ready',
    positionMs: 0,
    durationMs: 5000,
    seekableRange: { startMs: 0, endMs: 5000 },
    liveEdgeMs: null,
    atLiveEdge: false,
    playbackRate: 1,
    videoAttached: false,
    audio: { status: 'playing', codec: 'aac', sampleRate: 48000, channels: 2 },
    stats: {
      framesRendered: 0,
      framesDropped: 0,
      audioUnderruns: 0,
      avOffsetMs: 0,
    },
    ...over,
  };
}

describe('videopreview api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNative.createVideoPreviewPlayer.mockResolvedValue(snapshot());
    mockNative.videoPreviewSnapshot.mockResolvedValue(snapshot());
  });

  it('rejects invalid volume', async () => {
    await expect(
      createVideoPreviewPlayer(OFF, { volume: 2 })
    ).rejects.toBeInstanceOf(VideoPreviewError);
  });

  it('rejects inverted live latency', async () => {
    await expect(
      createVideoPreviewPlayer(OFF, {
        live: { targetLatencyMs: 3000, maxLatencyMs: 1000 },
      })
    ).rejects.toMatchObject({
      code: VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_ARGUMENT,
    });
  });

  it('creates a branded player and plays', async () => {
    const p = await createVideoPreviewPlayer(OFF);
    expect(p.playerId).toBe('vprev_1');
    expect(p.initialSnapshot.state).toBe('ready');
    await p.play();
    expect(mockNative.videoPreviewPlay).toHaveBeenCalled();
    await p.release();
    await expect(p.play()).rejects.toMatchObject({
      code: VideoPreviewErrorCode.VIDEO_PREVIEW_RELEASED,
    });
  });

  it('fires onAudioUnavailable for create-time unsupported audio', async () => {
    mockNative.createVideoPreviewPlayer.mockResolvedValue(
      snapshot({
        audio: {
          status: 'unavailable',
          reason: 'unsupportedCodec',
          code: 'VIDEO_AUDIO_CODEC_UNSUPPORTED',
          codec: 'ac3',
        },
      })
    );
    const onAudioUnavailable = jest.fn();
    const p = await createVideoPreviewPlayer(OFF, { onAudioUnavailable });
    expect(onAudioUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audioUnavailable',
        reason: 'unsupportedCodec',
        codec: 'ac3',
        videoContinues: true,
      })
    );
    expect(p.initialSnapshot.audio.status).toBe('unavailable');
  });
});

describe('videopreview events', () => {
  it('parses each event variant', () => {
    expect(
      mapNative({
        playerId: 'p',
        type: 'ended',
        payload: {},
      })
    ).toEqual({ type: 'ended' });
    expect(
      mapNative({
        playerId: 'p',
        type: 'stateChanged',
        payload: { state: 'playing', previousState: 'ready' },
      })
    ).toMatchObject({ type: 'stateChanged', state: 'playing' });
    expect(
      mapNative({
        playerId: 'p',
        type: 'audioUnavailable',
        payload: JSON.stringify({
          reason: 'absent',
          code: 'VIDEO_NO_AUDIO_TRACK',
          message: 'no audio',
        }),
      })
    ).toMatchObject({ type: 'audioUnavailable', reason: 'absent' });
  });

  it('drops unknown types', () => {
    expect(mapNative({ playerId: 'p', type: 'nope', payload: {} })).toBeNull();
  });
});
