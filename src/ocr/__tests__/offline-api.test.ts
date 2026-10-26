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
import {
  createOCR,
  detectOcrModel,
  isOcrModelType,
  OCR_MODEL_TYPES,
} from '../index';
import type { OcrInitializeOptions } from '../types';

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
    mockNative.ocrRecognize.mockResolvedValue({
      family: 'ppocr',
      spanCount: 1,
      doctags: '',
      markdown: '',
    });
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
      null,
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
    expect(result.paths?.det?.length).toBeGreaterThan(0);
    expect(result.paths?.rec?.length).toBeGreaterThan(0);
    expect(result.paths?.rec_dict?.length).toBeGreaterThan(0);
  });

  it('detectOcrModel forwards quantization to native', async () => {
    await detectOcrModel(
      { kind: 'fs', path: '/models/docvlm-granite-258m-q4f16' },
      { modelType: 'doc_vlm', quantization: 'q4f16' }
    );
    expect(mockNative.detectOcrModel).toHaveBeenCalledWith(
      '/models/docvlm-granite-258m-q4f16',
      'doc_vlm',
      'q4f16'
    );
  });

  it('createOCR auto forwards quantization to native', async () => {
    await createOCR({
      modelSource: { kind: 'fs', path: '/models/docvlm-granite-258m-fp16' },
      modelType: 'doc_vlm',
      quantization: 'fp16',
    });
    expect(mockNative.initializeOcr).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/),
      expect.objectContaining({
        modelDir: '/models/docvlm-granite-258m-fp16',
        modelType: 'doc_vlm',
        quantization: 'fp16',
      })
    );
  });

  it('detectOcrModel trusts native success without TS path completeness', async () => {
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
    expect(result.success).toBe(true);
    expect(result.modelType).toBe('ppocr');
    expect(result.paths?.det).toContain('det.onnx');
    expect(result.paths?.rec).toBeUndefined();
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

  it('detectOcrModel trusts native success when doctr manifest is absent from paths', async () => {
    mockNative.detectOcrModel.mockResolvedValue({
      success: true,
      ok: true,
      modelType: 'doctr',
      paths: { det: '/m/det.onnx', rec: '/m/rec.onnx' },
      detectedModels: [],
    });
    const result = await detectOcrModel({ kind: 'fs', path: '/m' });
    expect(result.success).toBe(true);
    expect(result.modelType).toBe('doctr');
    expect(result.paths?.manifest).toBeUndefined();
  });

  it('isOcrModelType recognizes valid types', () => {
    expect(isOcrModelType('ppocr')).toBe(true);
    expect(isOcrModelType('doctr')).toBe(true);
    expect(isOcrModelType('doc_vlm')).toBe(true);
    expect(isOcrModelType('nemotron_parse')).toBe(true);
    expect(isOcrModelType('auto')).toBe(true);
    expect(isOcrModelType('tessaract')).toBe(false);
    expect(isOcrModelType('docvlm')).toBe(false);
    expect(isOcrModelType('doc-vlm')).toBe(false);
    expect(isOcrModelType('granite-docling')).toBe(false);
    expect(isOcrModelType('docling')).toBe(false);
    expect(isOcrModelType('nemotron-parse')).toBe(false);
    expect(isOcrModelType('nemotron')).toBe(false);
  });

  it('OCR_MODEL_TYPES contains all expected entries', () => {
    expect(OCR_MODEL_TYPES).toContain('ppocr');
    expect(OCR_MODEL_TYPES).toContain('doctr');
    expect(OCR_MODEL_TYPES).toContain('doc_vlm');
    expect(OCR_MODEL_TYPES).toContain('nemotron_parse');
    expect(OCR_MODEL_TYPES).toContain('auto');
    expect(OCR_MODEL_TYPES).toHaveLength(5);
    expect(OCR_MODEL_TYPES[OCR_MODEL_TYPES.length - 1]).toBe('auto');
  });

  // ──── Phase 5: doctr round-trip tests ─────────────────────────────────

  it('createOCR ppocr forwards detUnclipRatio from ppocr options', async () => {
    mockNative.initializeOcr.mockResolvedValue({
      instanceId: 'ocr_ppocr_unclip',
      modelType: 'ppocr',
    });

    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/ppocrv6-tiny' },
      modelType: 'ppocr',
      ppocr: { detUnclipRatio: 1.2 },
    });

    expect(mockNative.initializeOcr).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/),
      expect.objectContaining({
        modelDir: '/models/ppocrv6-tiny',
        modelType: 'ppocr',
        detUnclipRatio: 1.2,
      })
    );
    await ocr.destroy();
  });

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
    expect(mockNative.ocrRecognize).not.toHaveBeenCalled();
  });

  it('createOCR doc_vlm + recognize round-trip returns extras then destroy', async () => {
    mockNative.initializeOcr.mockResolvedValue({
      instanceId: 'ocr_doc_vlm_rt',
      modelType: 'doc_vlm',
    });
    mockNative.ocrRecognize.mockResolvedValue({
      family: 'doc_vlm',
      spanCount: 3,
      doctags: '<doctag><text>Hi</text></doctag>',
      raw: '<doctag><text>Hi</text></doctag>',
      markdown: 'Hi',
      complete: true,
      stopReason: 'doctag_end',
    });

    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/docvlm-granite-258m-fp32' },
      modelType: 'doc_vlm',
      maxNewTokens: 512,
    });

    expect(mockNative.initializeOcr).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/),
      expect.objectContaining({
        modelDir: '/models/docvlm-granite-258m-fp32',
        modelType: 'doc_vlm',
        maxNewTokens: 512,
      })
    );

    const page = await ocr.recognize(
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
    expect(page).toEqual({
      family: 'doc_vlm',
      spanCount: 3,
      raw: '<doctag><text>Hi</text></doctag>',
      doctags: '<doctag><text>Hi</text></doctag>',
      markdown: 'Hi',
      complete: true,
      stopReason: 'doctag_end',
    });

    await ocr.destroy();
    expect(mockNative.unloadOcr).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/)
    );
  });

  it('recognize after destroy throws OCR_INSTANCE_NOT_FOUND for doc_vlm', async () => {
    mockNative.initializeOcr.mockResolvedValue({
      instanceId: 'ocr_doc_vlm_2',
      modelType: 'doc_vlm',
    });

    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/docvlm-granite-258m-fp32' },
      modelType: 'doc_vlm',
    });
    await ocr.destroy();

    await expect(
      ocr.recognize(
        'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      )
    ).rejects.toMatchObject({ code: 'OCR_INSTANCE_NOT_FOUND' });
    expect(mockNative.ocrRecognize).not.toHaveBeenCalled();
  });

  const docVlmPaths = {
    vision_encoder: '/models/docvlm/vision_encoder.onnx',
    vision_encoder_data: '/models/docvlm/vision_encoder.onnx_data',
    embed_tokens: '/models/docvlm/embed_tokens.onnx',
    embed_tokens_data: '/models/docvlm/embed_tokens.onnx_data',
    decoder: '/models/docvlm/decoder_model_merged.onnx',
    decoder_data: '/models/docvlm/decoder_model_merged.onnx_data',
    tokenizer: '/models/docvlm/tokenizer.json',
    manifest: '/models/docvlm/ocr_manifest.json',
  };

  it('createOCR doc_vlm forwards maxNewTokens', async () => {
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/docvlm-granite-258m-fp32' },
      modelType: 'doc_vlm',
      maxNewTokens: 512,
    });
    expect(mockNative.initializeOcr).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/),
      expect.objectContaining({
        modelType: 'doc_vlm',
        maxNewTokens: 512,
      })
    );
    await ocr.destroy();
  });

  it('createOCR doc_vlm omits maxNewTokens when maxNewTokens is absent', async () => {
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/docvlm-granite-258m-fp32' },
      modelType: 'doc_vlm',
    });
    const bridge = mockNative.initializeOcr.mock.calls[0]?.[1] as {
      maxNewTokens?: number;
    };
    expect(bridge).not.toHaveProperty('maxNewTokens');
    await ocr.destroy();
  });

  it('createOCR doc_vlm forwards maxNewTokens 0', async () => {
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/docvlm-granite-258m-fp32' },
      modelType: 'doc_vlm',
      maxNewTokens: 0,
    });
    expect(mockNative.initializeOcr).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/),
      expect.objectContaining({ maxNewTokens: 0 })
    );
    await ocr.destroy();
  });

  it('createOCR rewrites doc_vlm aliases before native init', async () => {
    for (const alias of ['docling', 'docvlm'] as const) {
      mockNative.initializeOcr.mockClear();
      const ocr = await createOCR({
        modelSource: { kind: 'fs', path: '/models/docvlm-granite-258m-fp32' },
        modelType: alias,
      } as unknown as OcrInitializeOptions);
      expect(mockNative.initializeOcr).toHaveBeenCalledWith(
        expect.stringMatching(/^ocr_/),
        expect.objectContaining({ modelType: 'doc_vlm' })
      );
      await ocr.destroy();
    }
  });

  it('createOCR rejects a non-integer or negative maxNewTokens', async () => {
    for (const maxNewTokens of [-1, 1.5, Number.NaN]) {
      mockNative.initializeOcr.mockClear();
      await expect(
        createOCR({
          modelSource: { kind: 'fs', path: '/models/docvlm-granite-258m-fp32' },
          modelType: 'doc_vlm',
          maxNewTokens,
        })
      ).rejects.toMatchObject({ code: 'OCR_INVALID_ARGUMENT' });
      expect(mockNative.initializeOcr).not.toHaveBeenCalled();
    }
  });

  it('ppocr recognize omits doctags and markdown', async () => {
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/ppocrv6-tiny' },
      modelType: 'ppocr',
    });
    const page = await ocr.recognize(
      'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    );
    expect(mockNative.ocrRecognize).toHaveBeenCalled();
    expect(page).toEqual({
      family: 'ppocr',
      spanCount: 1,
    });
    expect(page).not.toHaveProperty('doctags');
    expect(page).not.toHaveProperty('markdown');
    await ocr.destroy();
  });

  it('doctr recognize omits doctags and markdown', async () => {
    mockNative.ocrRecognize.mockResolvedValue({
      family: 'doctr',
      spanCount: 2,
      doctags: '',
      markdown: '',
    });
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/onnxtr-default' },
      modelType: 'doctr',
    });
    const page = await ocr.recognize(
      'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    );
    expect(page).toEqual({
      family: 'doctr',
      spanCount: 2,
    });
    expect(page).not.toHaveProperty('doctags');
    expect(page).not.toHaveProperty('markdown');
    await ocr.destroy();
  });

  it('doc_vlm recognize returns doctags and markdown', async () => {
    mockNative.ocrRecognize.mockResolvedValue({
      family: 'doc_vlm',
      spanCount: 3,
      doctags: '<doctag><text>Hi</text></doctag>',
      markdown: 'Hi',
      complete: true,
      stopReason: 'doctag_end',
    });
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/docvlm-granite-258m-fp32' },
      modelType: 'doc_vlm',
    });
    const page = await ocr.recognize(
      'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    );
    expect(page).toEqual({
      family: 'doc_vlm',
      spanCount: 3,
      raw: '<doctag><text>Hi</text></doctag>',
      doctags: '<doctag><text>Hi</text></doctag>',
      markdown: 'Hi',
      complete: true,
      stopReason: 'doctag_end',
    });
    await ocr.destroy();
  });

  it('createOCR rewrites nemotron-parse alias before native init', async () => {
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/nemotron-3.5-parse-int8' },
      modelType: 'nemotron-parse',
    } as unknown as OcrInitializeOptions);
    expect(mockNative.initializeOcr).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/),
      expect.objectContaining({ modelType: 'nemotron_parse' })
    );
    await ocr.destroy();
  });

  it('createOCR nemotron_parse + recognize returns raw extras', async () => {
    mockNative.initializeOcr.mockResolvedValue({
      instanceId: 'ocr_nemotron_rt',
      modelType: 'nemotron_parse',
    });
    mockNative.ocrRecognize.mockResolvedValue({
      family: 'nemotron_parse',
      spanCount: 1,
      raw: '<x_0.1><y_0.2>Hello<x_0.8><y_0.7><class_Text>',
      markdown: 'Hello',
      complete: true,
      stopReason: 'eos',
    });
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/nemotron-3.5-parse-int8' },
      modelType: 'nemotron_parse',
      maxNewTokens: 64,
    });
    expect(mockNative.initializeOcr).toHaveBeenCalledWith(
      expect.stringMatching(/^ocr_/),
      expect.objectContaining({
        modelType: 'nemotron_parse',
        maxNewTokens: 64,
      })
    );
    const page = await ocr.recognize(
      'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    );
    expect(page).toEqual({
      family: 'nemotron_parse',
      spanCount: 1,
      raw: '<x_0.1><y_0.2>Hello<x_0.8><y_0.7><class_Text>',
      markdown: 'Hello',
      complete: true,
      stopReason: 'eos',
    });
    expect(page).not.toHaveProperty('doctags');
    await ocr.destroy();
  });

  it('recognize rejects nemotron_parse when raw is missing', async () => {
    mockNative.ocrRecognize.mockResolvedValue({
      family: 'nemotron_parse',
      spanCount: 0,
      doctags: '<x_0><y_0>Hi<x_1><y_1><class_Text>',
      markdown: 'Hi',
      complete: true,
      stopReason: 'eos',
    });
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/nemotron-3.5-parse-int8' },
      modelType: 'nemotron_parse',
    });
    await expect(
      ocr.recognize(
        'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      )
    ).rejects.toMatchObject({ code: 'OCR_INTERNAL_ERROR' });
    await ocr.destroy();
  });

  it('recognize rejects when extras are missing', async () => {
    mockNative.ocrRecognize.mockResolvedValue({
      family: 'doc_vlm',
      spanCount: 0,
    });
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/docvlm-granite-258m-fp32' },
      modelType: 'doc_vlm',
    });
    await expect(
      ocr.recognize(
        'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      )
    ).rejects.toMatchObject({ code: 'OCR_INTERNAL_ERROR' });
    await ocr.destroy();
  });

  it('recognize rejects when doc_vlm complete or stopReason is missing', async () => {
    mockNative.ocrRecognize.mockResolvedValue({
      family: 'doc_vlm',
      spanCount: 0,
      doctags: '<doctag><text>Hi</text></doctag>',
      markdown: 'Hi',
    });
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/docvlm-granite-258m-fp32' },
      modelType: 'doc_vlm',
    });
    await expect(
      ocr.recognize(
        'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      )
    ).rejects.toMatchObject({ code: 'OCR_INTERNAL_ERROR' });
    mockNative.ocrRecognize.mockResolvedValue({
      family: 'doc_vlm',
      spanCount: 0,
      doctags: '<doctag><text>Hi</text></doctag>',
      markdown: 'Hi',
      complete: true,
      stopReason: 'not_a_reason',
    });
    await expect(
      ocr.recognize(
        'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      )
    ).rejects.toMatchObject({ code: 'OCR_INTERNAL_ERROR' });
    await ocr.destroy();
  });

  it('recognize rejects when family is missing', async () => {
    mockNative.ocrRecognize.mockResolvedValue({
      spanCount: 0,
      doctags: '',
      markdown: '',
    });
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/ppocrv6-tiny' },
      modelType: 'ppocr',
    });
    await expect(
      ocr.recognize(
        'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      )
    ).rejects.toMatchObject({ code: 'OCR_INTERNAL_ERROR' });
    await ocr.destroy();
  });

  it('recognize rejects a non-finite spanCount', async () => {
    mockNative.ocrRecognize.mockResolvedValue({
      family: 'ppocr',
      spanCount: Number.NaN,
      doctags: '',
      markdown: '',
    });
    const ocr = await createOCR({
      modelSource: { kind: 'fs', path: '/models/ppocrv6-tiny' },
      modelType: 'ppocr',
    });
    await expect(
      ocr.recognize(
        'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'txt_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      )
    ).rejects.toMatchObject({ code: 'OCR_INTERNAL_ERROR' });
    await ocr.destroy();
  });

  it('detectOcrModel accepts a mocked doc_vlm payload', async () => {
    mockNative.detectOcrModel.mockResolvedValue({
      success: true,
      ok: true,
      modelType: 'doc_vlm',
      paths: docVlmPaths,
      detectedModels: [
        { type: 'doc_vlm', modelDir: '/models/docvlm-granite-258m-fp32' },
      ],
    });
    const result = await detectOcrModel({
      kind: 'fs',
      path: '/models/docvlm-granite-258m-fp32',
    });
    expect(result.success).toBe(true);
    expect(result.modelType).toBe('doc_vlm');
    expect(result.paths?.rec_dict).toBeUndefined();
    expect(result.paths?.vision_encoder).toContain('vision_encoder.onnx');
    expect(typeof result.paths?.decoder).toBe('string');
  });

  it('detectOcrModel trusts native success for a partial doc_vlm paths map', async () => {
    mockNative.detectOcrModel.mockResolvedValue({
      success: true,
      ok: true,
      modelType: 'doc_vlm',
      paths: { vision_encoder: '/models/docvlm/vision_encoder.onnx' },
      detectedModels: [],
    });
    const result = await detectOcrModel({
      kind: 'fs',
      path: '/models/docvlm',
    });
    expect(result.success).toBe(true);
    expect(result.modelType).toBe('doc_vlm');
    expect(result.paths?.vision_encoder).toContain('vision_encoder.onnx');
    expect(result.paths?.decoder).toBeUndefined();
  });
});
