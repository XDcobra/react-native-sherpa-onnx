jest.unmock('../engine');
import SherpaOnnx from '../../NativeSherpaOnnx';
import { detectVadModel } from '../engine';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/vad',
    assetName: 'silero-vad',
  })),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => []),
  readPublicLanguageRows: jest.fn(() => []),
}));

describe('detectVadModel', () => {
  const mockSherpa = SherpaOnnx as jest.Mocked<typeof SherpaOnnx>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards modelType and quantization options to native detectVadModel', async () => {
    mockSherpa.detectVadModel.mockResolvedValue({
      success: true,
      modelType: 'silero_vad',
      isStreaming: true,
      detectedModels: [{ type: 'silero_vad', modelDir: '/models/vad' }],
      detectionSources: ['fileListing'],
      paths: { model: '/models/vad/silero_vad.int8.onnx' },
      quantization: 'int8',
    } as any);

    const res = await detectVadModel(
      { kind: 'fs', path: '/models/vad' },
      { modelType: 'silero_vad', quantization: 'int8' }
    );

    expect(mockSherpa.detectVadModel).toHaveBeenCalledWith(
      '/models/vad',
      'silero-vad',
      'silero_vad',
      'int8'
    );
    expect(res.success).toBe(true);
    expect(res.quantization).toBe('int8');
    expect(res.modelType).toBe('silero_vad');
  });
});
