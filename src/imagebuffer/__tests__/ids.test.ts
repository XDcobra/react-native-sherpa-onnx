jest.mock('react-native', () => {
  const listeners: Array<(event: unknown) => void> = [];
  const mockNative = {
    createEmptyLiveImageBuffer: jest.fn(),
    appendLiveImageFrame: jest.fn(),
    ingestFileToLiveImageBuffer: jest.fn(),
    finalizeLiveImageBuffer: jest.fn(),
    getOfflineImageBufferInfo: jest.fn(),
    releaseOfflineImageBuffer: jest.fn(),
  };
  return {
    NativeModules: { SherpaOnnx: {} },
    Platform: { OS: 'ios' },
    StyleSheet: { create: (s: unknown) => s },
    requireNativeComponent: jest.fn(() => {
      const React = require('react');
      return function MockNativeView() {
        return React.createElement('OfflineImageBufferFrameView');
      };
    }),
    NativeEventEmitter: class {
      addListener(
        event: string,
        cb: (event: unknown) => void
      ): { remove: () => void } {
        if (event === 'SherpaOnnxImageLiveEvent') listeners.push(cb);
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
    __emitLive: (event: unknown) => {
      for (const cb of listeners) cb(event);
    },
    __listenerCount: () => listeners.length,
  };
});

import {
  appendLiveImageFrame,
  createEmptyLiveImageBuffer,
  finalizeLiveImageBuffer,
  getPipelineImageBufferInfo,
  ingestFileToLiveImageBuffer,
  resolveLiveImageBufferId,
  resolveOfflineImageBufferId,
  resolvePipelineImageBufferId,
  subscribeLiveImageBufferEvents,
} from '../index';

const OFF = 'img_off_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LIVE = 'img_live_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('imagebuffer id resolvers', () => {
  it('accepts branded offline ids and refs', () => {
    expect(resolveOfflineImageBufferId(OFF)).toBe(OFF);
    expect(
      resolveOfflineImageBufferId({
        bufferId: OFF as never,
        info: {
          bufferId: OFF,
          kind: 'offlineImageBuffer',
          state: 'lazy',
          frameCount: 1,
          totalBytes: 0,
          storageKind: 'ram',
        },
      })
    ).toBe(OFF);
  });

  it('accepts finished live ids as offline sources', () => {
    expect(resolveOfflineImageBufferId(LIVE)).toBe(LIVE);
    expect(
      resolveOfflineImageBufferId({
        bufferId: LIVE as never,
        info: {
          bufferId: LIVE,
          kind: 'liveImageBuffer',
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
    expect(() => resolveOfflineImageBufferId('vid_off_x')).toThrow(
      /ERR_IMAGE_INVALID_ARGUMENT/
    );
    expect(() => resolveLiveImageBufferId(OFF)).toThrow(
      /ERR_IMAGE_INVALID_ARGUMENT/
    );
    expect(() => resolvePipelineImageBufferId('nope')).toThrow(
      /ERR_IMAGE_INVALID_ARGUMENT/
    );
  });

  it('resolvePipelineImageBufferId accepts both kinds', () => {
    expect(resolvePipelineImageBufferId(OFF)).toBe(OFF);
    expect(resolvePipelineImageBufferId(LIVE)).toBe(LIVE);
  });
});

describe('live ImageBuffer public API mapping', () => {
  const rn = jest.requireMock('react-native') as {
    __mockNative: {
      createEmptyLiveImageBuffer: jest.Mock;
      appendLiveImageFrame: jest.Mock;
      ingestFileToLiveImageBuffer: jest.Mock;
      finalizeLiveImageBuffer: jest.Mock;
      getOfflineImageBufferInfo: jest.Mock;
    };
    __emitLive: (event: unknown) => void;
    __listenerCount: () => number;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps live create and finalize', async () => {
    rn.__mockNative.createEmptyLiveImageBuffer.mockResolvedValue({
      bufferId: LIVE,
      kind: 'liveImageBuffer',
      state: 'recording',
      frameCount: 0,
      totalFramesWritten: 0,
      ringEvictedFrames: 0,
      hasActiveSpool: true,
    });
    const live = await createEmptyLiveImageBuffer({ retention: 'session' });
    expect(rn.__mockNative.createEmptyLiveImageBuffer).toHaveBeenCalledWith({
      ringFrames: 16,
      retention: 'session',
    });
    expect(live.info.state).toBe('recording');
    expect(live.info.hasActiveSpool).toBe(true);

    rn.__mockNative.finalizeLiveImageBuffer.mockResolvedValue({
      bufferId: LIVE,
      kind: 'liveImageBuffer',
      state: 'finished',
      frameCount: 8,
      totalFramesWritten: 8,
      hasActiveSpool: true,
    });
    const done = await finalizeLiveImageBuffer(live);
    expect(done.info.state).toBe('finished');
    expect(resolveOfflineImageBufferId(done)).toBe(LIVE);
  });

  it('maps ingest FileSource onto the native live id', async () => {
    const source = { kind: 'fs' as const, path: '/tmp/a.jpg' };
    rn.__mockNative.ingestFileToLiveImageBuffer.mockResolvedValue({
      bufferId: LIVE,
      kind: 'liveImageBuffer',
      state: 'recording',
      frameCount: 1,
      totalFramesWritten: 1,
      ringEvictedFrames: 0,
      hasActiveSpool: true,
    });
    const info = await ingestFileToLiveImageBuffer(source, LIVE);
    expect(rn.__mockNative.ingestFileToLiveImageBuffer).toHaveBeenCalledWith(
      source,
      LIVE
    );
    expect(info.frameCount).toBe(1);
  });

  it('rejects a string path for ingest instead of FileSource', async () => {
    await expect(
      ingestFileToLiveImageBuffer('/tmp/a.jpg' as never, LIVE)
    ).rejects.toThrow(
      /ERR_IMAGE_INVALID_ARGUMENT: source must be a FileSource/
    );
    expect(rn.__mockNative.ingestFileToLiveImageBuffer).not.toHaveBeenCalled();
  });

  it('forwards compressed base64 on append', async () => {
    rn.__mockNative.appendLiveImageFrame.mockResolvedValue({
      bufferId: LIVE,
      kind: 'liveImageBuffer',
      state: 'recording',
      frameCount: 2,
      totalFramesWritten: 2,
      ringEvictedFrames: 0,
      hasActiveSpool: false,
    });
    const info = await appendLiveImageFrame(LIVE, 'Zm9v');
    expect(rn.__mockNative.appendLiveImageFrame).toHaveBeenCalledWith(
      LIVE,
      'Zm9v'
    );
    expect(info.frameCount).toBe(2);
  });

  it('maps pipeline info for live ids', async () => {
    rn.__mockNative.getOfflineImageBufferInfo.mockResolvedValue({
      bufferId: LIVE,
      kind: 'liveImageBuffer',
      state: 'recording',
      frameCount: 3,
      totalFramesWritten: 5,
      ringEvictedFrames: 2,
      hasActiveSpool: 'true',
      totalBytes: 0,
      storageKind: 'ram',
    });
    const info = await getPipelineImageBufferInfo(LIVE);
    expect(info.kind).toBe('liveImageBuffer');
    if (info.kind === 'liveImageBuffer') {
      expect(info.hasActiveSpool).toBe(true);
      expect(info.ringEvictedFrames).toBe(2);
    }
  });

  it('parses live events for the subscribed buffer only', () => {
    const seen: string[] = [];
    const unsub = subscribeLiveImageBufferEvents(LIVE, (e) => {
      seen.push(e.type);
    });
    expect(rn.__listenerCount()).toBe(1);
    rn.__emitLive({
      type: 'framesAppended',
      liveBufferId: LIVE,
      frameCount: 3,
    });
    rn.__emitLive({ type: 'overflow', liveBufferId: LIVE });
    rn.__emitLive({ type: 'finished', liveBufferId: 'img_live_other' });
    expect(seen).toEqual(['framesAppended', 'overflow']);
    unsub();
    expect(rn.__listenerCount()).toBe(0);
  });
});
