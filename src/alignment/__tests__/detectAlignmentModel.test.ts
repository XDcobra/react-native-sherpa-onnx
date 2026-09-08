import SherpaOnnx from '../../NativeSherpaOnnx';
import { detectAlignmentModel } from '../index';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/wav2vec2',
    assetName: 'wav2vec2-alignment',
  })),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => []),
  readPublicLanguageRows: jest.fn(() => []),
}));

describe('detectAlignmentModel', () => {
  const mockSherpa = SherpaOnnx as jest.Mocked<typeof SherpaOnnx>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards modelType and quantization options to native detectAlignmentModel', async () => {
    mockSherpa.detectAlignmentModel.mockResolvedValue({
      success: true,
      modelType: 'wav2vec2',
      isStreaming: false,
      detectedModels: [{ type: 'wav2vec2', modelDir: '/models/wav2vec2' }],
      detectionSources: ['fileListing'],
      paths: { model: '/models/wav2vec2/model.int8.onnx' },
      quantization: 'int8',
    } as any);

    const res = await detectAlignmentModel(
      { kind: 'fs', path: '/models/wav2vec2' },
      { modelType: 'wav2vec2', quantization: 'int8' }
    );

    expect(mockSherpa.detectAlignmentModel).toHaveBeenCalledWith(
      '/models/wav2vec2',
      'wav2vec2',
      'int8'
    );
    expect(res.success).toBe(true);
    expect(res.quantization).toBe('int8');
    expect(res.modelType).toBe('wav2vec2');
  });
});
