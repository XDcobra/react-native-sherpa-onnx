jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectSpeakerEmbeddingModel: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/speaker-embedding',
    assetName: 'wespeaker_en_voxceleb_resnet34.onnx',
  })),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => []),
  readPublicLanguageRows: jest.fn(() => []),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { detectSpeakerEmbeddingModel } from '../index';

describe('detectSpeakerEmbeddingModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps non-empty native paths.model into the result', async () => {
    (SherpaOnnx.detectSpeakerEmbeddingModel as jest.Mock).mockResolvedValue({
      success: true,
      isStreaming: false,
      modelType: 'wespeaker',
      detectedModels: [
        { type: 'wespeaker', modelDir: '/models/speaker-embedding' },
      ],
      paths: {
        model: '/models/speaker-embedding/wespeaker_en_voxceleb_resnet34.onnx',
      },
    });

    const result = await detectSpeakerEmbeddingModel({
      kind: 'fs',
      path: '/models/speaker-embedding',
    });

    expect(result.paths).toEqual({
      model: '/models/speaker-embedding/wespeaker_en_voxceleb_resnet34.onnx',
    });
    expect(result.isStreaming).toBe(false);
    expect(result.modelType).toBe('wespeaker');
  });

  it('omits paths when native model path is empty or whitespace', async () => {
    (SherpaOnnx.detectSpeakerEmbeddingModel as jest.Mock).mockResolvedValue({
      success: false,
      isStreaming: false,
      detectedModels: [],
      paths: { model: '   ' },
    });

    const result = await detectSpeakerEmbeddingModel({
      kind: 'fs',
      path: '/models/speaker-embedding',
    });

    expect(result.paths).toBeUndefined();
  });
});
