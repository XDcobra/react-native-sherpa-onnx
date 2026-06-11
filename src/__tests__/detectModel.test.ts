jest.mock('../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectModel: jest.fn(),
    detectModelsBatch: jest.fn(),
  },
}));

import SherpaOnnx from '../NativeSherpaOnnx';
import {
  detectModel,
  detectModelResultMatchesCategory,
  detectModelsBatch,
  isQnnModelName,
} from '../detect/detectModel';
import { ModelCategory } from '../download/types';

const mockSherpa = SherpaOnnx as jest.Mocked<typeof SherpaOnnx>;

function mockNoHits(): void {
  mockSherpa.detectModel.mockResolvedValue({
    matched: false,
    success: false,
    detectedModels: [],
  });
  mockSherpa.detectModelsBatch.mockResolvedValue([]);
}

describe('detectModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNoHits();
  });

  it('returns first matching detector result (TTS before STT)', async () => {
    mockSherpa.detectModel.mockResolvedValue({
      matched: true,
      success: true,
      category: 'tts',
      modelType: 'vits',
      detectedModels: [{ type: 'vits', modelDir: '/models/vits' }],
      detectionSources: ['fileListing'],
      paths: {
        ttsModel: '/models/vits/model.onnx',
        tokens: '/models/vits/tokens.txt',
      },
      languages: [{ iso6391Hint: 'en', id: 'en' }],
      quantization: 'int8',
      sizeTier: 'small',
      isStreaming: true,
    });

    const result = await detectModel({ assetName: 'vits-piper-en' });

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        category: ModelCategory.Tts,
        modelType: 'vits',
        isStreaming: true,
        paths: {
          ttsModel: '/models/vits/model.onnx',
          tokens: '/models/vits/tokens.txt',
        },
        detectionSources: ['fileListing'],
        detectedModels: [{ type: 'vits', modelDir: '/models/vits' }],
      })
    );
    expect(mockSherpa.detectModel).toHaveBeenCalledWith('', 'vits-piper-en');
  });

  it('returns matched false when native reports no hit', async () => {
    const result = await detectModel({ assetName: 'not-a-model' });
    expect(result).toEqual({ matched: false });
  });

  it('maps native separation category to ModelCategory.Separation', async () => {
    mockSherpa.detectModel.mockResolvedValue({
      matched: true,
      success: true,
      category: 'separation',
      modelType: 'uvr',
      detectedModels: [{ type: 'uvr', modelDir: '.' }],
      detectionSources: ['nameOnly'],
      paths: { model: '/models/UVR-MDX-NET-Inst_1.onnx' },
      isStreaming: false,
    });

    const result = await detectModel({ assetName: 'UVR-MDX-NET-Inst_1.onnx' });

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        category: ModelCategory.Separation,
        modelType: 'uvr',
        isStreaming: false,
        paths: { model: '/models/UVR-MDX-NET-Inst_1.onnx' },
      })
    );
    expect(mockSherpa.detectModel).toHaveBeenCalledWith(
      '',
      'UVR-MDX-NET-Inst_1.onnx'
    );
  });

  it('sets supportsQnn on STT hits with QNN naming', async () => {
    mockSherpa.detectModel.mockResolvedValue({
      matched: true,
      success: true,
      category: 'stt',
      modelType: 'transducer',
      detectedModels: [],
      isStreaming: false,
    });

    const qnnName = 'sherpa-onnx-qnn-binary-en-seconds-2024-01-01';
    const result = await detectModel({ assetName: qnnName });

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        category: ModelCategory.Stt,
        supportsQnn: true,
      })
    );
  });
});

describe('detectModelsBatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNoHits();
  });

  it('returns one result per input preserving order', async () => {
    mockSherpa.detectModelsBatch.mockResolvedValue([
      {
        matched: true,
        success: true,
        category: 'tts',
        modelType: 'vits',
        detectedModels: [],
        isStreaming: true,
        paths: { ttsModel: '/x.onnx' },
      },
      {
        matched: false,
        success: false,
        detectedModels: [],
      },
    ]);

    const results = await detectModelsBatch([
      { assetName: 'vits-en' },
      { assetName: 'missing' },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(
      expect.objectContaining({ matched: true, category: ModelCategory.Tts })
    );
    expect(results[0]).not.toHaveProperty('paths');
    expect(results[1]).toEqual({ matched: false });
    expect(mockSherpa.detectModelsBatch).toHaveBeenCalledWith([
      { modelDir: '', assetName: 'vits-en' },
      { modelDir: '', assetName: 'missing' },
    ]);
  });

  it('includes paths in batch results when includePaths is true', async () => {
    mockSherpa.detectModelsBatch.mockResolvedValue([
      {
        matched: true,
        success: true,
        category: 'tts',
        modelType: 'vits',
        detectedModels: [],
        isStreaming: true,
        paths: { ttsModel: '/x.onnx', tokens: '/x/tokens.txt' },
      },
    ]);

    const results = await detectModelsBatch([{ assetName: 'vits-en' }], {
      includePaths: true,
    });

    expect(results[0]).toEqual(
      expect.objectContaining({
        matched: true,
        paths: { ttsModel: '/x.onnx', tokens: '/x/tokens.txt' },
      })
    );
  });
});

describe('detectModelResultMatchesCategory', () => {
  const sttHit = {
    matched: true as const,
    category: ModelCategory.Stt,
    modelType: 'paraformer',
    languages: [],
    quantization: 'unknown' as const,
    sizeTier: 'unknown' as const,
    isStreaming: false,
  };

  const qnnHit = {
    ...sttHit,
    supportsQnn: true,
  };

  it('routes QNN catalog slice to supportsQnn STT hits only', () => {
    expect(detectModelResultMatchesCategory(ModelCategory.Qnn, qnnHit)).toBe(
      true
    );
    expect(detectModelResultMatchesCategory(ModelCategory.Qnn, sttHit)).toBe(
      false
    );
    expect(detectModelResultMatchesCategory(ModelCategory.Stt, sttHit)).toBe(
      true
    );
    expect(detectModelResultMatchesCategory(ModelCategory.Stt, qnnHit)).toBe(
      false
    );
  });
});

describe('isQnnModelName', () => {
  it('matches QNN binary release naming', () => {
    expect(isQnnModelName('sherpa-onnx-qnn-binary-en-seconds-2024-01-01')).toBe(
      true
    );
    expect(isQnnModelName('sherpa-onnx-paraformer-zh-int8')).toBe(false);
  });
});
