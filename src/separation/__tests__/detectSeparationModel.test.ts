jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectSeparationModel: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/separation/spleeter',
    assetName: 'sherpa-onnx-spleeter-2stems',
  })),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => []),
  readPublicLanguageRows: jest.fn(() => []),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { detectSeparationModel } from '../index';

describe('detectSeparationModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps Spleeter native paths into the result', async () => {
    (SherpaOnnx.detectSeparationModel as jest.Mock).mockResolvedValue({
      success: true,
      modelType: 'spleeter',
      detectedModels: [
        { type: 'spleeter', modelDir: '/models/separation/spleeter' },
      ],
      paths: {
        vocals: '/models/separation/spleeter/vocals.onnx',
        accompaniment: '/models/separation/spleeter/accompaniment.onnx',
      },
    });

    const result = await detectSeparationModel({
      kind: 'fs',
      path: '/models/separation/spleeter',
    });

    expect(result.isStreaming).toBe(false);
    expect(result.paths).toEqual({
      vocals: '/models/separation/spleeter/vocals.onnx',
      accompaniment: '/models/separation/spleeter/accompaniment.onnx',
    });
  });

  it('forwards resolved modelDir and assetName to native detect', async () => {
    const { resolveFileSourceForDetect } = jest.requireMock(
      '../../detect/resolveModelInput'
    );
    resolveFileSourceForDetect.mockResolvedValueOnce({
      modelDir: '/data/models/separation/spleeter',
      assetName: 'sherpa-onnx-spleeter-2stems',
    });
    (SherpaOnnx.detectSeparationModel as jest.Mock).mockResolvedValue({
      success: true,
      modelType: 'spleeter',
      detectedModels: [],
    });

    await detectSeparationModel({
      kind: 'fs',
      path: '/data/models/separation/spleeter',
    });

    expect(SherpaOnnx.detectSeparationModel).toHaveBeenCalledWith(
      '/data/models/separation/spleeter',
      'sherpa-onnx-spleeter-2stems',
      null
    );
  });

  it('uses explicit assetName option over resolved default', async () => {
    (SherpaOnnx.detectSeparationModel as jest.Mock).mockResolvedValue({
      success: true,
      detectedModels: [],
    });

    await detectSeparationModel(
      { kind: 'fs', path: '/models/dir' },
      { assetName: 'UVR-MDX-NET-Inst_1.onnx' }
    );

    expect(SherpaOnnx.detectSeparationModel).toHaveBeenCalledWith(
      '/models/separation/spleeter',
      'UVR-MDX-NET-Inst_1.onnx',
      null
    );
  });

  it('maps UVR native model path and omits empty keys', async () => {
    (SherpaOnnx.detectSeparationModel as jest.Mock).mockResolvedValue({
      success: true,
      modelType: 'uvr',
      detectedModels: [{ type: 'uvr', modelDir: '.' }],
      paths: {
        model: '/models/UVR-MDX-NET-Inst_1.onnx',
        vocals: '   ',
      },
    });

    const result = await detectSeparationModel({
      kind: 'fs',
      path: '/models/UVR-MDX-NET-Inst_1.onnx',
    });

    expect(result.paths).toEqual({
      model: '/models/UVR-MDX-NET-Inst_1.onnx',
    });
  });
});
