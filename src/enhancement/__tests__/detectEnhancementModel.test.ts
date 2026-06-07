jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectEnhancementModel: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/enhancement',
    assetName: 'sherpa-onnx-speech-enhancement-gtcrn',
  })),
}));

jest.mock('../../model-languages', () => ({
  resolvePublicLanguageHints: jest.fn(() => []),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { detectEnhancementModel } from '../index';

describe('detectEnhancementModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps non-empty native paths.model into the result', async () => {
    (SherpaOnnx.detectEnhancementModel as jest.Mock).mockResolvedValue({
      success: true,
      isStreaming: true,
      modelType: 'gtcrn',
      detectedModels: [{ type: 'gtcrn', modelDir: '/models/enhancement' }],
      paths: { model: '/models/enhancement/gtcrn.onnx' },
    });

    const result = await detectEnhancementModel({
      kind: 'fs',
      path: '/models/enhancement',
    });

    expect(result.paths).toEqual({
      model: '/models/enhancement/gtcrn.onnx',
    });
  });

  it('omits paths when native model path is empty or whitespace', async () => {
    (SherpaOnnx.detectEnhancementModel as jest.Mock).mockResolvedValue({
      success: false,
      isStreaming: false,
      detectedModels: [],
      paths: { model: '   ' },
    });

    const result = await detectEnhancementModel({
      kind: 'fs',
      path: '/models/enhancement',
    });

    expect(result.paths).toBeUndefined();
  });
});
