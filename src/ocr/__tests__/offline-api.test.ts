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
import type { OcrDetectModelResult } from '../../types/modelDetect';
import {
  createOCR,
  detectOcrModel,
  isOcrPpocrDetectSuccess,
  isOcrDoctrDetectSuccess,
  isOcrModelType,
  OCR_MODEL_TYPES,
} from '../index';

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
      detectionSources: ['fileListing', 'fallbackOrder', 'curatedCatalog'],
      sizeTier: 'tiny',
      languages: [
        { iso6391Hint: 'zh', id: 'zh' },
        { iso6391Hint: 'en', id: 'en' },
        { iso6391Hint: 'de', id: 'de' },
      ],
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
    expect(result.detectionSources).toEqual([
      'fileListing',
      'fallbackOrder',
      'curatedCatalog',
    ]);
    expect(result.sizeTier).toBe('tiny');
    expect(result.languages).toEqual([
      { iso6391Hint: 'zh', id: 'zh' },
      { iso6391Hint: 'en', id: 'en' },
      { iso6391Hint: 'de', id: 'de' },
    ]);
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

  // ──── Phase 3: doctr tests ────────────────────────────────────────────

  it('createOCR with doctr modelType passes doctr options to native', async () => {
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/onnxtr-default' },
      modelType: 'doctr',
      doctr: { detBoxThresh: 0.2, detBoxScoreThresh: 0.2 },
    });
    expect(mockNative.initializeOcr).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/),
      expect.objectContaining({
        modelDir: '/models/onnxtr-default',
        modelType: 'doctr',
        detBoxThresh: 0.2,
        detBoxScoreThresh: 0.2,
      })
    );
    await ocr.destroy();
  });

  it('detectOcrModel returns doctr paths with manifest', async () => {
    mockNative.detectOcrModel.mockResolvedValue({
      success: true,
      ok: true,
      modelType: 'doctr',
      family: 'doctr',
      detectedModels: [{ type: 'doctr', modelDir: '/models/onnxtr-default' }],
      paths: {
        det: '/models/onnxtr-default/det.onnx',
        rec: '/models/onnxtr-default/rec.onnx',
        manifest: '/models/onnxtr-default/ocr_manifest.json',
      },
      detectionSources: ['fileListing', 'fallbackOrder'],
      sizeTier: 'medium',
      languages: [
        { iso6391Hint: 'en', id: 'en' },
        { iso6391Hint: 'fr', id: 'fr' },
      ],
    });
    const result = await detectOcrModel({
      kind: 'fs',
      path: '/models/onnxtr-default',
    });
    expect(result.success).toBe(true);
    expect(result.modelType).toBe('doctr');
    expect(result.paths?.manifest).toContain('ocr_manifest.json');
    expect(result.paths?.det).toContain('det.onnx');
    expect(result.paths?.rec).toContain('rec.onnx');
    expect(result.paths?.rec_dict).toBeUndefined();
  });

  it('isOcrDoctrDetectSuccess narrows doctr paths', () => {
    const result: OcrDetectModelResult = {
      success: true,
      isStreaming: false,
      detectedModels: [{ type: 'doctr', modelDir: '/m' }],
      modelType: 'doctr',
      paths: {
        det: '/m/det.onnx',
        rec: '/m/rec.onnx',
        manifest: '/m/ocr_manifest.json',
      },
    };
    expect(isOcrDoctrDetectSuccess(result)).toBe(true);
    if (isOcrDoctrDetectSuccess(result)) {
      expect(result.paths.manifest.length).toBeGreaterThan(0);
    }
  });

  it('isOcrDoctrDetectSuccess rejects ppocr result', () => {
    const result: OcrDetectModelResult = {
      success: true,
      isStreaming: false,
      detectedModels: [{ type: 'ppocr', modelDir: '/m' }],
      modelType: 'ppocr',
      paths: {
        det: '/m/det.onnx',
        rec: '/m/rec.onnx',
        rec_dict: '/m/dict.yml',
      },
    };
    expect(isOcrDoctrDetectSuccess(result)).toBe(false);
  });

  it('detectOcrModel fails for doctr when manifest is missing', async () => {
    mockNative.detectOcrModel.mockResolvedValue({
      success: true,
      ok: true,
      modelType: 'doctr',
      paths: { det: '/m/det.onnx', rec: '/m/rec.onnx' },
      detectedModels: [],
    });
    const result = await detectOcrModel({ kind: 'fs', path: '/m' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required paths/i);
  });

  it('isOcrModelType recognizes valid types', () => {
    expect(isOcrModelType('ppocr')).toBe(true);
    expect(isOcrModelType('doctr')).toBe(true);
    expect(isOcrModelType('auto')).toBe(true);
    expect(isOcrModelType('tessaract')).toBe(false);
  });

  it('OCR_MODEL_TYPES contains all expected entries', () => {
    expect(OCR_MODEL_TYPES).toContain('ppocr');
    expect(OCR_MODEL_TYPES).toContain('doctr');
    expect(OCR_MODEL_TYPES).toContain('auto');
    expect(OCR_MODEL_TYPES).toHaveLength(3);
  });

  // ──── Phase 5: doctr round-trip tests ─────────────────────────────────

  it('createOCR doctr + recognize round-trip passes doctr bridge options', async () => {
    mockNative.initializeOcr.mockResolvedValue({
      instanceId: 'ocr_doctr_1',
      modelType: 'doctr',
    });

    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/doctr-mobile' },
      modelType: 'doctr',
      doctr: {
        detBoxThresh: 0.15,
        detBoxScoreThresh: 0.15,
        detUnclipRatio: 1.5,
      },
    });

    expect(mockNative.initializeOcr).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/),
      expect.objectContaining({
        modelDir: '/models/doctr-mobile',
        modelType: 'doctr',
        detBoxThresh: 0.15,
        detBoxScoreThresh: 0.15,
        detUnclipRatio: 1.5,
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
    expect(mockNative.unloadOcr).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/)
    );
  });

  it('recognize after destroy throws OCR_INSTANCE_NOT_FOUND for doctr', async () => {
    mockNative.initializeOcr.mockResolvedValue({
      instanceId: 'ocr_doctr_2',
      modelType: 'doctr',
    });

    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/doctr-mobile' },
      modelType: 'doctr',
    });
    await ocr.destroy();

    await expect(
      ocr.recognize(
        'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      )
    ).rejects.toMatchObject({ code: 'OCR_INSTANCE_NOT_FOUND' });
  });
});
