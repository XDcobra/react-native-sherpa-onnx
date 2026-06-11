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

describe('categoryUsesCatalogDetect', () => {
  it('includes detect-backed download categories', () => {
    expect(categoryUsesCatalogDetect(ModelCategory.Tts)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Stt)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Qnn)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Vad)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Punctuation)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Enhancement)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Separation)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Alignment)).toBe(true);
  });

  it('excludes diarization', () => {
    expect(categoryUsesCatalogDetect(ModelCategory.Diarization)).toBe(false);
  });
});
