jest.mock('react-native', () => {
  const listeners: Array<(event: unknown) => void> = [];
  const mockNative = {
    createEmptyOfflineImageBuffer: jest.fn(),
    createOfflineImageBufferFromFiles: jest.fn(),
    createOfflineImageBufferFromBase64: jest.fn(),
    getOfflineImageBufferInfo: jest.fn(),
    getOfflineImageBufferFrameInfo: jest.fn(),
    ensureOfflineImageBufferFrame: jest.fn(),
    releaseOfflineImageBuffer: jest.fn(),
    cancelOfflineImageBufferCreate: jest.fn(),
    exportOfflineImageBufferFrame: jest.fn(),
  };

  return {
    NativeModules: {
      SherpaOnnx: {},
    },
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
        if (event === 'SherpaOnnxImageProgress') {
          listeners.push(cb);
        }
        return {
          remove: () => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          },
        };
      }
    },
    TurboModuleRegistry: {
      getEnforcing: () => mockNative,
    },
    __mockNative: mockNative,
    __emitImageProgress: (event: unknown) => {
      for (const cb of listeners) cb(event);
    },
    __listenerCount: () => listeners.length,
  };
});

import {
  createEmptyOfflineImageBuffer,
  createOfflineImageBufferFromBase64,
  createOfflineImageBufferFromFiles,
  ensureOfflineImageBufferFrame,
  exportOfflineImageBufferFrame,
  getOfflineImageBufferFrameInfo,
  getOfflineImageBufferInfo,
  ImageErrorCode,
  releaseOfflineImageBuffer,
} from '../index';

describe('offline ImageBuffer public API', () => {
  const bufferId = 'img_off_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const reactNativeMock = jest.requireMock('react-native') as {
    __mockNative: {
      createEmptyOfflineImageBuffer: jest.Mock;
      createOfflineImageBufferFromFiles: jest.Mock;
      createOfflineImageBufferFromBase64: jest.Mock;
      getOfflineImageBufferInfo: jest.Mock;
      getOfflineImageBufferFrameInfo: jest.Mock;
      ensureOfflineImageBufferFrame: jest.Mock;
      releaseOfflineImageBuffer: jest.Mock;
      cancelOfflineImageBufferCreate: jest.Mock;
      exportOfflineImageBufferFrame: jest.Mock;
    };
    __emitImageProgress: (event: unknown) => void;
    __listenerCount: () => number;
  };
  const mockNative = reactNativeMock.__mockNative;

  const infoPayload = {
    bufferId,
    kind: 'offlineImageBuffer',
    state: 'immutable',
    frameCount: 2,
    totalBytes: 1024,
    storageKind: 'mmap',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockNative.createEmptyOfflineImageBuffer.mockResolvedValue({
      ...infoPayload,
      frameCount: 0,
      totalBytes: 0,
      storageKind: 'ram',
    });
    mockNative.createOfflineImageBufferFromFiles.mockResolvedValue(infoPayload);
    mockNative.createOfflineImageBufferFromBase64.mockResolvedValue(
      infoPayload
    );
    mockNative.getOfflineImageBufferInfo.mockResolvedValue(infoPayload);
    mockNative.getOfflineImageBufferFrameInfo.mockResolvedValue({
      index: 0,
      width: 64,
      height: 48,
      byteSize: 9216,
      storageKind: 'mmap',
    });
    mockNative.releaseOfflineImageBuffer.mockResolvedValue(undefined);
    mockNative.cancelOfflineImageBufferCreate.mockResolvedValue(undefined);
  });

  it('createOfflineImageBufferFromFiles forwards FileSource array and maxSide', async () => {
    const sources = [
      { kind: 'fs' as const, path: '/tmp/a.jpg' },
      { kind: 'contentUri' as const, uri: 'content://x' },
    ];
    const result = await createOfflineImageBufferFromFiles(sources, {
      maxSide: 2048,
      hotFrames: 2,
    });
    expect(mockNative.createOfflineImageBufferFromFiles).toHaveBeenCalledWith(
      sources,
      expect.objectContaining({
        maxSide: 2048,
        hotFrames: 2,
        operationId: expect.stringMatching(/^img_create_/),
      })
    );
    expect(result.bufferId).toBe(bufferId);
    expect(result.info.storageKind).toBe('mmap');
    expect(result.info.frameCount).toBe(2);
  });

  it('createOfflineImageBufferFromFiles accepts a single FileSource', async () => {
    const source = { kind: 'fs' as const, path: '/tmp/one.png' };
    await createOfflineImageBufferFromFiles(source);
    expect(mockNative.createOfflineImageBufferFromFiles).toHaveBeenCalledWith(
      [source],
      expect.objectContaining({
        operationId: expect.stringMatching(/^img_create_/),
      })
    );
  });

  it('rejects malformed buffer ids on getInfo', async () => {
    await expect(getOfflineImageBufferInfo('not-an-id')).rejects.toThrow(
      /ERR_IMAGE_INVALID_ARGUMENT/
    );
    expect(mockNative.getOfflineImageBufferInfo).not.toHaveBeenCalled();
  });

  it('maps file-create state lazy from native', async () => {
    mockNative.createOfflineImageBufferFromFiles.mockResolvedValue({
      ...infoPayload,
      state: 'lazy',
      totalBytes: 0,
      storageKind: 'ram',
    });
    const result = await createOfflineImageBufferFromFiles({
      kind: 'fs',
      path: '/tmp/a.jpg',
    });
    expect(result.info.state).toBe('lazy');
    expect(result.info.totalBytes).toBe(0);
  });

  it('maps storageKind and frame info from native', async () => {
    const info = await getOfflineImageBufferInfo(bufferId);
    expect(info.storageKind).toBe('mmap');
    const frame = await getOfflineImageBufferFrameInfo(bufferId, 0);
    expect(frame.width).toBe(64);
    expect(frame.storageKind).toBe('mmap');
  });

  it('createEmpty / release forward to native', async () => {
    const empty = await createEmptyOfflineImageBuffer();
    expect(empty.info.frameCount).toBe(0);
    await releaseOfflineImageBuffer(empty);
    expect(mockNative.releaseOfflineImageBuffer).toHaveBeenCalledWith(
      empty.bufferId
    );
  });

  it('createOfflineImageBufferFromBase64 forwards list and options', async () => {
    await createOfflineImageBufferFromBase64(['YQ=='], { maxSide: 512 });
    expect(mockNative.createOfflineImageBufferFromBase64).toHaveBeenCalledWith(
      ['YQ=='],
      expect.objectContaining({
        maxSide: 512,
        operationId: expect.stringMatching(/^img_create_/),
      })
    );
  });

  it('onProgress receives filtered events for this create operationId', async () => {
    const seen: Array<{ done: number; total: number; phase: string }> = [];
    mockNative.createOfflineImageBufferFromFiles.mockImplementation(
      async (_sources: unknown, opts: { operationId: string }) => {
        reactNativeMock.__emitImageProgress({
          operationId: 'other-op',
          done: 0,
          total: 2,
          phase: 'index',
        });
        reactNativeMock.__emitImageProgress({
          operationId: opts.operationId,
          done: 1,
          total: 2,
          phase: 'index',
        });
        return infoPayload;
      }
    );

    await createOfflineImageBufferFromFiles(
      { kind: 'fs', path: '/tmp/a.jpg' },
      { onProgress: (e) => seen.push(e) }
    );

    expect(seen).toEqual([{ done: 1, total: 2, phase: 'index' }]);
    expect(reactNativeMock.__listenerCount()).toBe(0);
  });

  it('AbortSignal calls native cancelOfflineImageBufferCreate', async () => {
    const controller = new AbortController();
    let resolveNative!: (v: typeof infoPayload) => void;
    mockNative.createOfflineImageBufferFromFiles.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveNative = resolve;
        })
    );

    const pending = createOfflineImageBufferFromFiles(
      { kind: 'fs', path: '/tmp/a.jpg' },
      { signal: controller.signal }
    );

    // Allow subscription setup
    await Promise.resolve();
    controller.abort();
    expect(mockNative.cancelOfflineImageBufferCreate).toHaveBeenCalledWith(
      expect.stringMatching(/^img_create_/)
    );

    resolveNative(infoPayload);
    await pending;
  });

  it('already-aborted signal rejects before native create', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createOfflineImageBufferFromFiles(
        { kind: 'fs', path: '/tmp/a.jpg' },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: 'ERR_IMAGE_CANCELLED' });
    expect(mockNative.createOfflineImageBufferFromFiles).not.toHaveBeenCalled();
  });

  it('maps disabled native error to ERR_IMAGE_WEBP_DISABLED', async () => {
    mockNative.createOfflineImageBufferFromFiles.mockRejectedValue(
      new Error('ERR_IMAGE_WEBP_DISABLED: libwebp is not linked')
    );
    await expect(
      createOfflineImageBufferFromFiles({ kind: 'fs', path: '/tmp/a.webp' })
    ).rejects.toMatchObject({ code: ImageErrorCode.WEBP_DISABLED });
  });

  it('export webp maps disabled native error to ERR_IMAGE_WEBP_DISABLED', async () => {
    mockNative.exportOfflineImageBufferFrame.mockRejectedValue(
      new Error('ERR_IMAGE_WEBP_DISABLED: libwebp is not linked')
    );
    await expect(
      exportOfflineImageBufferFrame(
        bufferId,
        0,
        { kind: 'fs', path: '/tmp/out.webp' },
        {
          format: 'webp',
        }
      )
    ).rejects.toMatchObject({ code: ImageErrorCode.WEBP_DISABLED });
  });

  it('exportOfflineImageBufferFrame passes FileDestination and returns ResolvedFileRef', async () => {
    mockNative.exportOfflineImageBufferFrame.mockResolvedValue({
      outputKind: 'fs',
      outputPath: '/tmp/out.jpg',
    });

    const ref = await exportOfflineImageBufferFrame(
      bufferId,
      0,
      { kind: 'fs', path: '/tmp/out.jpg' },
      { format: 'jpeg', quality: 90 }
    );

    expect(mockNative.exportOfflineImageBufferFrame).toHaveBeenCalledWith(
      bufferId,
      0,
      { kind: 'fs', path: '/tmp/out.jpg' },
      { format: 'jpeg', quality: 90, maxSide: 0 }
    );
    expect(ref).toEqual({ kind: 'fs', path: '/tmp/out.jpg' });
  });

  it('ensureOfflineImageBufferFrame forwards to native and maps frame info', async () => {
    mockNative.ensureOfflineImageBufferFrame.mockResolvedValue({
      index: 1,
      width: 800,
      height: 600,
      byteSize: 800 * 600 * 3,
      storageKind: 'ram',
      pageNumber: 2,
      dpi: 144,
    });

    const frame = await ensureOfflineImageBufferFrame(bufferId, 1);
    expect(mockNative.ensureOfflineImageBufferFrame).toHaveBeenCalledWith(
      bufferId,
      1
    );
    expect(frame).toEqual({
      index: 1,
      width: 800,
      height: 600,
      byteSize: 800 * 600 * 3,
      storageKind: 'ram',
      pageNumber: 2,
      dpi: 144,
    });
  });

  it('mapInfo preserves lazy state from native', async () => {
    mockNative.getOfflineImageBufferInfo.mockResolvedValue({
      ...infoPayload,
      state: 'lazy',
      totalBytes: 0,
    });
    const info = await getOfflineImageBufferInfo(bufferId);
    expect(info.state).toBe('lazy');
  });
});
