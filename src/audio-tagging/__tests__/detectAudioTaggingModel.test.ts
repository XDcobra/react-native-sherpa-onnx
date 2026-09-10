jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAudioTaggingModel: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/audio-tagging',
    assetName: 'sherpa-onnx-ced-tiny-audio-tagging-2024-04-19',
  })),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => []),
  readPublicLanguageRows: jest.fn(() => []),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { detectAudioTaggingModel } from '../index';

describe('detectAudioTaggingModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps non-empty native paths into the result', async () => {
    (SherpaOnnx.detectAudioTaggingModel as jest.Mock).mockResolvedValue({
      success: true,
      isStreaming: false,
      modelType: 'ced',
      detectedModels: [{ type: 'ced', modelDir: '/models/audio-tagging' }],
      paths: {
        model: '/models/audio-tagging/model.onnx',
        labels: '/models/audio-tagging/class_labels_indices.csv',
      },
    });

    const result = await detectAudioTaggingModel({
      kind: 'fs',
      path: '/models/audio-tagging',
    });

    expect(result.paths).toEqual({
      model: '/models/audio-tagging/model.onnx',
      labels: '/models/audio-tagging/class_labels_indices.csv',
    });
    expect(result.isStreaming).toBe(false);
  });

  it('omits paths when native model/labels paths are empty or whitespace', async () => {
    (SherpaOnnx.detectAudioTaggingModel as jest.Mock).mockResolvedValue({
      success: false,
      isStreaming: false,
      detectedModels: [],
      paths: { model: '   ', labels: '' },
    });

    const result = await detectAudioTaggingModel({
      kind: 'fs',
      path: '/models/audio-tagging',
    });

    expect(result.paths).toBeUndefined();
  });

  it('forwards quantization option to native detectAudioTaggingModel', async () => {
    (SherpaOnnx.detectAudioTaggingModel as jest.Mock).mockResolvedValue({
      success: true,
      isStreaming: false,
      modelType: 'zipformer',
      detectedModels: [],
      paths: {
        model: '/models/audio-tagging/model.int8.onnx',
        labels: '/models/audio-tagging/class_labels_indices.csv',
      },
      quantization: 'int8',
    });

    const result = await detectAudioTaggingModel(
      { kind: 'fs', path: '/models/audio-tagging' },
      { quantization: 'int8' }
    );

    expect(SherpaOnnx.detectAudioTaggingModel).toHaveBeenCalledWith(
      '/models/audio-tagging',
      'sherpa-onnx-ced-tiny-audio-tagging-2024-04-19',
      null,
      'int8'
    );
    expect(result.quantization).toBe('int8');
  });
});
