jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../detect', () => {
  const { detectModelResultMatchesCategory } = jest.requireActual(
    '../../detect/detectModel'
  );
  return {
    detectModelsBatch: jest.fn(),
    detectModelResultMatchesCategory,
  };
});

import { ModelCategory } from '../types';
import { categoryUsesCatalogDetect } from '../catalogDetectCategories';
import { buildCatalogHintsMap } from '../catalogHints';
import { detectModelsBatch } from '../../detect';

const mockDetectModelsBatch = detectModelsBatch as jest.Mock;

describe('buildCatalogHintsMap — Separation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('merges name-only unified detect hits for Spleeter and UVR ids', async () => {
    mockDetectModelsBatch.mockResolvedValue([
      {
        matched: true,
        category: ModelCategory.Separation,
        modelType: 'spleeter',
        languages: [],
        quantization: 'fp16',
        sizeTier: 'unknown',
        isStreaming: false,
      },
      {
        matched: true,
        category: ModelCategory.Separation,
        modelType: 'uvr',
        languages: [],
        quantization: 'unknown',
        sizeTier: 'unknown',
        isStreaming: false,
      },
    ]);

    const hints = await buildCatalogHintsMap(ModelCategory.Separation, [
      'sherpa-onnx-spleeter-2stems-fp16',
      'UVR-MDX-NET-Inst_1',
    ]);

    expect(hints.get('sherpa-onnx-spleeter-2stems-fp16')).toEqual({
      modelType: 'spleeter',
      languages: [],
      quantization: 'fp16',
      sizeTier: 'unknown',
      isStreaming: false,
    });
    expect(hints.get('UVR-MDX-NET-Inst_1')?.modelType).toBe('uvr');
    expect(mockDetectModelsBatch).toHaveBeenCalledWith([
      { assetName: 'sherpa-onnx-spleeter-2stems-fp16' },
      { assetName: 'UVR-MDX-NET-Inst_1' },
    ]);
  });

  it('returns unknown hint when detect category does not match', async () => {
    mockDetectModelsBatch.mockResolvedValue([
      {
        matched: true,
        category: ModelCategory.Enhancement,
        modelType: 'gtcrn',
        languages: [],
        quantization: 'unknown',
        sizeTier: 'unknown',
        isStreaming: true,
      },
    ]);

    const hints = await buildCatalogHintsMap(ModelCategory.Separation, [
      'gtcrn_simple',
    ]);

    expect(hints.get('gtcrn_simple')?.modelType).toBe('unknown');
  });
});

describe('buildCatalogHintsMap — OCR', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('merges name-only unified detect language hints for ppocr packs', async () => {
    mockDetectModelsBatch.mockResolvedValue([
      {
        matched: true,
        category: ModelCategory.Ocr,
        modelType: 'ppocr',
        languages: ['zh', 'en'],
        quantization: 'unknown',
        sizeTier: 'tiny',
        isStreaming: false,
      },
    ]);

    const hints = await buildCatalogHintsMap(ModelCategory.Ocr, [
      'ppocrv6-tiny',
    ]);

    expect(hints.get('ppocrv6-tiny')).toEqual({
      modelType: 'ppocr',
      languages: ['zh', 'en'],
      quantization: 'unknown',
      sizeTier: 'tiny',
      isStreaming: false,
    });
    expect(mockDetectModelsBatch).toHaveBeenCalledWith([
      { assetName: 'ppocrv6-tiny' },
    ]);
  });

  it('merges name-only unified detect language hints for doctr packs', async () => {
    mockDetectModelsBatch.mockResolvedValue([
      {
        matched: true,
        category: ModelCategory.Ocr,
        modelType: 'doctr',
        languages: ['en', 'fr'],
        quantization: 'unknown',
        sizeTier: 'unknown',
        isStreaming: false,
      },
    ]);

    const hints = await buildCatalogHintsMap(ModelCategory.Ocr, [
      'doctr-mobile',
    ]);

    expect(hints.get('doctr-mobile')).toEqual({
      modelType: 'doctr',
      languages: ['en', 'fr'],
      quantization: 'unknown',
      sizeTier: 'unknown',
      isStreaming: false,
    });
    expect(mockDetectModelsBatch).toHaveBeenCalledWith([
      { assetName: 'doctr-mobile' },
    ]);
  });

  it('merges name-only unified detect language hints for doc_vlm packs', async () => {
    mockDetectModelsBatch.mockResolvedValue([
      {
        matched: true,
        category: ModelCategory.Ocr,
        modelType: 'doc_vlm',
        languages: ['en', 'ja', 'ar', 'zh'],
        quantization: 'fp32',
        sizeTier: 'unknown',
        isStreaming: false,
      },
    ]);

    const hints = await buildCatalogHintsMap(ModelCategory.Ocr, [
      'docvlm-granite-258m-fp32',
    ]);

    expect(hints.get('docvlm-granite-258m-fp32')).toEqual({
      modelType: 'doc_vlm',
      languages: ['en', 'ja', 'ar', 'zh'],
      quantization: 'fp32',
      sizeTier: 'unknown',
      isStreaming: false,
    });
    expect(mockDetectModelsBatch).toHaveBeenCalledWith([
      { assetName: 'docvlm-granite-258m-fp32' },
    ]);
  });
});

describe('categoryUsesCatalogDetect', () => {
  it('includes detect-backed download categories', () => {
    expect(categoryUsesCatalogDetect(ModelCategory.Tts)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Stt)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Qnn)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Vad)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Punctuation)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Enhancement)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Separation)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.SpeakerEmbedding)).toBe(
      true
    );
    expect(categoryUsesCatalogDetect(ModelCategory.Diarization)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Alignment)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Ocr)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.LanguageId)).toBe(true);
  });
});
