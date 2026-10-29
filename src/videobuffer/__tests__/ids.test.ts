jest.mock('../../imagebuffer', () => ({
  exportOfflineImageBufferFrame: jest.fn(),
  releaseOfflineImageBuffer: jest.fn(),
}));

jest.mock('react-native', () => {
  const listeners: Array<(event: unknown) => void> = [];
  const mockNative = {
    createOfflineVideoBufferFromFile: jest.fn(),
    createEmptyLiveVideoBuffer: jest.fn(),
    ingestFileToLiveVideoBuffer: jest.fn(),
    finalizeLiveVideoBuffer: jest.fn(),
    getVideoBufferInfo: jest.fn(),
    getVideoKeyframeTimes: jest.fn(),
    releaseVideoBuffer: jest.fn(),
    createOfflineImageBufferFromVideo: jest.fn(),
  };
  return {
    NativeModules: { SherpaOnnx: {} },
    NativeEventEmitter: class {
      addListener(
        event: string,
        cb: (event: unknown) => void
      ): { remove: () => void } {
        if (event === 'SherpaOnnxVideoEvent') listeners.push(cb);
        return {
          remove: () => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          },
        };
      }
    },
    TurboModuleRegistry: { getEnforcing: () => mockNative },
    __mockNative: mockNative,
    __emitVideo: (event: unknown) => {
      for (const cb of listeners) cb(event);
    },
    __listenerCount: () => listeners.length,
  };
});

import {
  createEmptyLiveVideoBuffer,
  createOfflineVideoBufferFromFile,
  finalizeLiveVideoBuffer,
  resolveLiveVideoBufferId,
  resolveOfflineVideoBufferId,
  resolvePipelineVideoBufferId,
  subscribeLiveVideoBufferEvents,
} from '../index';

const OFF = 'vid_off_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LIVE = 'vid_live_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('videobuffer id resolvers', () => {
  it('accepts branded offline ids and refs', () => {
    expect(resolveOfflineVideoBufferId(OFF)).toBe(OFF);
    expect(
      resolveOfflineVideoBufferId({
        bufferId: OFF as never,
        info: {
          bufferId: OFF,
          kind: 'offlineVideoBuffer',
          state: 'immutable',
          frameCount: 1,
        },
      })
    ).toBe(OFF);
  });

  it('accepts finished live ids as offline sources', () => {
    expect(resolveOfflineVideoBufferId(LIVE)).toBe(LIVE);
    expect(
      resolveOfflineVideoBufferId({
        bufferId: LIVE as never,
        info: {
          bufferId: LIVE,
          kind: 'liveVideoBuffer',
          state: 'finished',
          frameCount: 2,
          totalFramesWritten: 2,
          ringEvictedFrames: 0,
          hasActiveSpool: false,
        },
      })
    ).toBe(LIVE);
  });

  it('rejects malformed ids', () => {
    expect(() => resolveOfflineVideoBufferId('img_off_x')).toThrow(
      /VIDEO_INVALID_ARGUMENT/
    );
    expect(() => resolveLiveVideoBufferId(OFF)).toThrow(
      /VIDEO_INVALID_ARGUMENT/
    );
    expect(() => resolvePipelineVideoBufferId('nope')).toThrow(
      /VIDEO_INVALID_ARGUMENT/
    );
  });

  it('resolvePipelineVideoBufferId accepts both kinds', () => {
    expect(resolvePipelineVideoBufferId(OFF)).toBe(OFF);
    expect(resolvePipelineVideoBufferId(LIVE)).toBe(LIVE);
  });
});

describe('videobuffer public API mapping', () => {
  const rn = jest.requireMock('react-native') as {
    __mockNative: {
      createOfflineVideoBufferFromFile: jest.Mock;
      createEmptyLiveVideoBuffer: jest.Mock;
      finalizeLiveVideoBuffer: jest.Mock;
    };
    __emitVideo: (event: unknown) => void;
    __listenerCount: () => number;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps offline create and brands the handle', async () => {
    rn.__mockNative.createOfflineVideoBufferFromFile.mockResolvedValue({
      bufferId: OFF,
      kind: 'offlineVideoBuffer',
      state: 'immutable',
      frameCount: 12,
    });
    const ref = await createOfflineVideoBufferFromFile('/tmp/a.mp4');
    expect(ref.bufferId).toBe(OFF);
    expect(ref.info.kind).toBe('offlineVideoBuffer');
    expect(ref.info.frameCount).toBe(12);
  });

  it('maps live create and finalize', async () => {
    rn.__mockNative.createEmptyLiveVideoBuffer.mockResolvedValue({
      bufferId: LIVE,
      kind: 'liveVideoBuffer',
      state: 'recording',
      frameCount: 0,
      totalFramesWritten: 0,
      ringEvictedFrames: 0,
      hasActiveSpool: 'true',
    });
    const live = await createEmptyLiveVideoBuffer({ retention: 'session' });
    expect(live.info.state).toBe('recording');
    expect(live.info.hasActiveSpool).toBe(true);

    rn.__mockNative.finalizeLiveVideoBuffer.mockResolvedValue({
      bufferId: LIVE,
      kind: 'liveVideoBuffer',
      state: 'finished',
      frameCount: 8,
      totalFramesWritten: 8,
      hasActiveSpool: 'true',
    });
    const done = await finalizeLiveVideoBuffer(live);
    expect(done.info.state).toBe('finished');
    expect(resolveOfflineVideoBufferId(done)).toBe(LIVE);
  });

  it('parses live events for the subscribed buffer only', () => {
    const seen: string[] = [];
    const unsub = subscribeLiveVideoBufferEvents(LIVE, (e) => {
      seen.push(e.type);
    });
    expect(rn.__listenerCount()).toBe(1);
    rn.__emitVideo({
      type: 'packetsAppended',
      liveBufferId: LIVE,
      frameCount: 3,
    });
    rn.__emitVideo({ type: 'finished', liveBufferId: 'vid_live_other' });
    expect(seen).toEqual(['packetsAppended']);
    unsub();
    expect(rn.__listenerCount()).toBe(0);
  });
});
