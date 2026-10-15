jest.mock('react-native', () => {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const mockNative = {
    initializeOcr: jest.fn(),
    ocrRecognize: jest.fn(),
    unloadOcr: jest.fn(),
    cancelOcrRecognize: jest.fn(),
    detectOcrModel: jest.fn(),
  };

  return {
    NativeEventEmitter: jest.fn().mockImplementation(() => ({
      addListener: (event: string, cb: (e: any) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
        return {
          remove: () => listeners.get(event)?.delete(cb),
        };
      },
    })),
    NativeModules: { SherpaOnnx: {} },
    TurboModuleRegistry: {
      getEnforcing: () => mockNative,
    },
    __mockNative: mockNative,
    __emit: (event: string, payload: any) => {
      listeners.get(event)?.forEach((cb) => cb(payload));
    },
  };
});

jest.mock('../../imagebuffer', () => ({
  resolveOfflineImageBufferId: (id: string) => id,
}));

jest.mock('../../textbuffer', () => ({
  resolveOfflineTextBufferId: (id: string) => id,
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(async () => '/models/ppocrv6-tiny'),
}));

import { createOCR, detectOcrModel } from '../index';

describe('ocr offline API', () => {
  const reactNativeMock = jest.requireMock('react-native') as {
    __mockNative: {
      initializeOcr: jest.Mock;
      ocrRecognize: jest.Mock;
      unloadOcr: jest.Mock;
      cancelOcrRecognize: jest.Mock;
      detectOcrModel: jest.Mock;
    };
    __emit: (event: string, payload: any) => void;
  };
  const mockNative = reactNativeMock.__mockNative;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNative.initializeOcr.mockResolvedValue({
      instanceId: 'ocr_1',
      modelType: 'ppocr',
    });
    mockNative.ocrRecognize.mockResolvedValue(undefined);
    mockNative.unloadOcr.mockResolvedValue(undefined);
    mockNative.cancelOcrRecognize.mockResolvedValue(undefined);
    mockNative.detectOcrModel.mockResolvedValue({
      ok: true,
      modelType: 'ppocr',
      family: 'ppocr',
      hasDet: true,
      hasRec: true,
      hasCls: true,
      hasRecYml: true,
      files: {
        det: true,
        rec: true,
        cls: true,
        recInferenceYml: true,
      },
    });
  });

  it('createOCR initializes and recognize passes operationId', async () => {
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/ppocrv6-tiny' },
      modelType: 'ppocr',
    });
    expect(mockNative.initializeOcr).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/),
      expect.objectContaining({
        modelDir: '/models/ppocrv6-tiny',
        modelType: 'ppocr',
      })
    );

    await ocr.recognize(
      'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    );

    expect(mockNative.ocrRecognize).toHaveBeenCalledWith(
      ocr.instanceId,
      'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      expect.objectContaining({
        operationId: expect.stringMatching(/^ocr_rec_/),
      })
    );

    await ocr.destroy();
    expect(mockNative.unloadOcr).toHaveBeenCalledWith(ocr.instanceId);
  });

  it('onProgress receives filtered events for this recognize operationId', async () => {
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/ppocrv6-tiny' },
    });
    const onProgress = jest.fn();
    mockNative.ocrRecognize.mockImplementation(
      async (
        _id: string,
        _img: string,
        _txt: string,
        opts: { operationId: string }
      ) => {
        reactNativeMock.__emit('SherpaOnnxOcrProgress', {
          operationId: 'other-op',
          done: 1,
          total: 1,
          phase: 'recognize',
        });
        reactNativeMock.__emit('SherpaOnnxOcrProgress', {
          operationId: opts.operationId,
          done: 1,
          total: 2,
          phase: 'recognize',
        });
      }
    );

    await ocr.recognize(
      'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      { onProgress }
    );

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith({
      done: 1,
      total: 2,
      phase: 'recognize',
    });
    await ocr.destroy();
  });

  it('AbortSignal calls native cancelOcrRecognize', async () => {
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/ppocrv6-tiny' },
    });
    const controller = new AbortController();
    mockNative.ocrRecognize.mockImplementation(async () => {
      controller.abort();
      await new Promise((r) => setTimeout(r, 0));
    });

    await ocr.recognize(
      'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      { signal: controller.signal }
    );

    expect(mockNative.cancelOcrRecognize).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_rec_/)
    );
    await ocr.destroy();
  });

  it('detectOcrModel maps files', async () => {
    const result = await detectOcrModel('/models/ppocrv6-tiny');
    expect(result.ok).toBe(true);
    expect(result.modelType).toBe('ppocr');
    expect(result.files.det).toBe(true);
    expect(result.files.recInferenceYml).toBe(true);
  });
});
