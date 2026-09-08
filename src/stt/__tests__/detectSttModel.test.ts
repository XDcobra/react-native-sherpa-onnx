import SherpaOnnx from '../../NativeSherpaOnnx';
import { detectSttModel } from '../index';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/whisper',
    assetName: 'whisper-tiny',
  })),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => []),
  readPublicLanguageRows: jest.fn(() => []),
}));

describe('detectSttModel', () => {
  const mockSherpa = SherpaOnnx as jest.Mocked<typeof SherpaOnnx>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards modelType, quantization, and debug options to native detectSttModel', async () => {
    mockSherpa.detectSttModel.mockResolvedValue({
      success: true,
      modelType: 'whisper',
      isStreaming: false,
      detectedModels: [{ type: 'whisper', modelDir: '/models/whisper' }],
      detectionSources: ['fileListing'],
      paths: { whisperEncoder: '/models/whisper/tiny-encoder.int8.onnx' },
      quantization: 'int8',
    } as any);

    const res = await detectSttModel(
      { kind: 'fs', path: '/models/whisper' },
      { modelType: 'whisper', quantization: 'int8', debug: true }
    );

    expect(mockSherpa.detectSttModel).toHaveBeenCalledWith(
      '/models/whisper',
      'whisper-tiny',
      'whisper',
      'int8',
      true
    );
    expect(res.success).toBe(true);
    expect(res.quantization).toBe('int8');
    expect(res.modelType).toBe('whisper');
  });
});
