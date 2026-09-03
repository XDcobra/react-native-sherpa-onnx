jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectDiarizationModel: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/diarization',
    assetName: 'sherpa-onnx-pyannote-segmentation-3-0',
  })),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => []),
  readPublicLanguageRows: jest.fn(() => []),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { detectDiarizationModel } from '../index';

describe('detectDiarizationModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps non-empty native paths.model into the result', async () => {
    (SherpaOnnx.detectDiarizationModel as jest.Mock).mockResolvedValue({
      success: true,
      isStreaming: false,
      modelType: 'pyannote',
      detectedModels: [{ type: 'pyannote', modelDir: '/models/diarization' }],
      paths: {
        model: '/models/diarization/model.onnx',
      },
    });

    const result = await detectDiarizationModel({
      kind: 'fs',
      path: '/models/diarization',
    });

    expect(result.paths).toEqual({
      model: '/models/diarization/model.onnx',
    });
    expect(result.isStreaming).toBe(false);
    expect(result.modelType).toBe('pyannote');
  });

  it('omits paths when native model path is empty or whitespace', async () => {
    (SherpaOnnx.detectDiarizationModel as jest.Mock).mockResolvedValue({
      success: false,
      isStreaming: false,
      detectedModels: [],
      paths: { model: '   ' },
    });

    const result = await detectDiarizationModel({
      kind: 'fs',
      path: '/models/diarization',
    });

    expect(result.paths).toBeUndefined();
  });
});
