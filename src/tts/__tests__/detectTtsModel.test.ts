import SherpaOnnx from '../../NativeSherpaOnnx';
import { detectTtsModel } from '../index';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/vits',
    assetName: 'vits-piper-en',
  })),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => []),
  readPublicLanguageRows: jest.fn(() => []),
}));

describe('detectTtsModel', () => {
  const mockSherpa = SherpaOnnx as jest.Mocked<typeof SherpaOnnx>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards modelType and quantization options to native detectTtsModel', async () => {
    mockSherpa.detectTtsModel.mockResolvedValue({
      success: true,
      modelType: 'vits',
      isStreaming: true,
      detectedModels: [{ type: 'vits', modelDir: '/models/vits' }],
      detectionSources: ['fileListing'],
      paths: {
        ttsModel: '/models/vits/model.int8.onnx',
        tokens: '/models/vits/tokens.txt',
      },
      quantization: 'int8',
    } as any);

    const res = await detectTtsModel(
      { kind: 'fs', path: '/models/vits' },
      { modelType: 'vits', quantization: 'int8' }
    );

    expect(mockSherpa.detectTtsModel).toHaveBeenCalledWith(
      '/models/vits',
      'vits-piper-en',
      'vits',
      'int8'
    );
    expect(res.success).toBe(true);
    expect(res.quantization).toBe('int8');
    expect(res.modelType).toBe('vits');
  });
});
