jest.mock('react-native', () => {
  const mockNative = {
    detectOcrModel: jest.fn(),
    initializeOcr: jest.fn(),
    ocrRecognize: jest.fn(),
    unloadOcr: jest.fn(),
    cancelOcrRecognize: jest.fn(),
  };
  return {
    NativeEventEmitter: jest.fn().mockImplementation(() => ({
      addListener: jest.fn(() => ({ remove: jest.fn() })),
    })),
    NativeModules: { SherpaOnnx: {} },
    TurboModuleRegistry: {
      getEnforcing: () => mockNative,
    },
    __mockNative: mockNative,
  };
});

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async (source: { path?: string }) => ({
    modelDir:
      typeof source === 'object' && source && 'path' in source
        ? String((source as { path: string }).path)
        : '/models/ppocrv6-tiny',
    assetName: 'ppocrv6-tiny',
  })),
  resolveFileSourceForModelInit: jest.fn(async (source: { path?: string }) =>
    typeof source === 'object' && source && 'path' in source
      ? String((source as { path: string }).path)
      : '/models/ppocrv6-tiny'
  ),
}));

jest.mock('../../imagebuffer', () => ({
  resolveOfflineImageBufferId: jest.fn(
    () => 'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  ),
}));

jest.mock('../../textbuffer', () => ({
  resolveOfflineTextBufferId: jest.fn(
    () => 'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  ),
}));

import { TurboModuleRegistry } from 'react-native';
import { createOCR, detectOcrModel, isOcrPpocrDetectSuccess } from '../index';

const mockNative = (
  TurboModuleRegistry.getEnforcing as unknown as () => {
    detectOcrModel: jest.Mock;
    initializeOcr: jest.Mock;
    ocrRecognize: jest.Mock;
    unloadOcr: jest.Mock;
    cancelOcrRecognize: jest.Mock;
  }
)();

describe('ocr offline API', () => {
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
      success: true,
      ok: true,
      modelType: 'ppocr',
      family: 'ppocr',
      detectedModels: [{ type: 'ppocr', modelDir: '/models/ppocrv6-tiny' }],
      paths: {
        det: '/models/ppocrv6-tiny/det.onnx',
        rec: '/models/ppocrv6-tiny/rec.onnx',
        cls: '/models/ppocrv6-tiny/cls.onnx',
        rec_dict: '/models/ppocrv6-tiny/rec_inference.yml',
      },
      detectionSources: ['fileListing', 'fallbackOrder'],
      sizeTier: 'tiny',
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
      'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      { granularity: 'line' }
    );
    expect(mockNative.ocrRecognize).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/),
      'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      expect.objectContaining({
        operationId: expect.stringMatching(/^ocr_rec_/),
        granularity: 'line',
      })
    );
    await ocr.destroy();
  });

  it('onProgress receives filtered events for this recognize operationId', async () => {
    const { NativeEventEmitter } = jest.requireMock('react-native') as {
      NativeEventEmitter: jest.Mock;
    };
    type ProgressCb = (...args: readonly Object[]) => unknown;
    const holder: { listener?: ProgressCb } = {};
    NativeEventEmitter.mockImplementation(() => ({
      addListener: jest.fn((_event: string, cb: ProgressCb) => {
        holder.listener = cb;
        return { remove: jest.fn() };
      }),
    }));

    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/ppocrv6-tiny' },
    });
    const onProgress = jest.fn();
    const recognizePromise = ocr.recognize(
      'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      { onProgress }
    );
    const opId = mockNative.ocrRecognize.mock.calls[0]?.[3]
      ?.operationId as string;
    expect(holder.listener).toBeDefined();
    holder.listener!({
      operationId: opId,
      done: 1,
      total: 2,
      phase: 'recognize',
    });
    holder.listener!({
      operationId: 'other',
      done: 9,
      total: 9,
      phase: 'recognize',
    });
    await recognizePromise;
    expect(onProgress).toHaveBeenCalledWith({
      done: 1,
      total: 2,
      phase: 'recognize',
    });
    expect(onProgress).toHaveBeenCalledTimes(1);
    await ocr.destroy();
  });

  it('AbortSignal calls native cancelOcrRecognize', async () => {
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/ppocrv6-tiny' },
    });
    const controller = new AbortController();
    const recognizePromise = ocr.recognize(
      'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      { signal: controller.signal }
    );
    controller.abort();
    expect(mockNative.cancelOcrRecognize).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_rec_/)
    );
    await recognizePromise;
    await ocr.destroy();
  });

  it('detectOcrModel maps FileSource to success paths and DetectionSource', async () => {
    const result = await detectOcrModel({
      kind: 'fs',
      path: '/models/ppocrv6-tiny',
    });
    expect(mockNative.detectOcrModel).toHaveBeenCalledWith(
      '/models/ppocrv6-tiny',
      null
    );
    expect(result.success).toBe(true);
    expect(result.isStreaming).toBe(false);
    expect(result.modelType).toBe('ppocr');
    expect(result.paths?.det).toContain('det.onnx');
    expect(result.paths?.rec_dict).toContain('rec_inference.yml');
    expect(result.detectionSources).toEqual(['fileListing', 'fallbackOrder']);
    expect(result.sizeTier).toBe('tiny');
    expect(isOcrPpocrDetectSuccess(result)).toBe(true);
    if (isOcrPpocrDetectSuccess(result)) {
      expect(result.paths.det.length).toBeGreaterThan(0);
      expect(result.paths.rec.length).toBeGreaterThan(0);
      expect(result.paths.rec_dict.length).toBeGreaterThan(0);
    }
  });

  it('detectOcrModel fails when required paths are missing despite ok', async () => {
    mockNative.detectOcrModel.mockResolvedValue({
      success: true,
      ok: true,
      modelType: 'ppocr',
      paths: { det: '/models/x/det.onnx' },
      detectedModels: [],
    });
    const result = await detectOcrModel({
      kind: 'fs',
      path: '/models/x',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required paths/i);
  });
});
