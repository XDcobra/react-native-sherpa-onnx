import SherpaOnnx from '../../NativeSherpaOnnx';
import { detectPunctuationModel } from '../detect';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/punct',
    assetName: 'punct-model',
  })),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => []),
  readPublicLanguageRows: jest.fn(() => []),
}));

describe('detectPunctuationModel', () => {
  const mockSherpa = SherpaOnnx as jest.Mocked<typeof SherpaOnnx>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards modelType and quantization options to native', async () => {
    mockSherpa.detectPunctuationModel.mockResolvedValue({
      success: true,
      category: 'punctuation',
      selectedKind: 0,
      detectedModels: [],
      detectionSources: ['fileListing'],
      paths: { ct_transformer: '/models/punct/model.onnx' },
      quantization: 'int8',
    } as any);

    const res = await detectPunctuationModel(
      { kind: 'fs', path: '/models/punct' },
      { modelType: 'ct_transformer', quantization: 'int8' }
    );

    expect(mockSherpa.detectPunctuationModel).toHaveBeenCalledWith(
      '/models/punct',
      'punct-model',
      'ct_transformer',
      'int8'
    );
    expect(res.success).toBe(true);
    expect(res.quantization).toBe('int8');
  });
});
