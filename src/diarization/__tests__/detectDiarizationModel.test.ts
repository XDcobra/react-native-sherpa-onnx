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

  it('maps sortformer model and metadata into result when both are present', async () => {
    (SherpaOnnx.detectDiarizationModel as jest.Mock).mockResolvedValue({
      success: true,
      isStreaming: true,
      modelType: 'sortformer',
      detectedModels: [
        {
          type: 'sortformer',
          modelDir: '/models/diar_streaming_sortformer_4spk',
        },
      ],
      paths: {
        model: '/models/diar_streaming_sortformer_4spk/model.onnx',
        metadata: '/models/diar_streaming_sortformer_4spk/metadata.json',
      },
    });

    const result = await detectDiarizationModel({
      kind: 'fs',
      path: '/models/diar_streaming_sortformer_4spk',
    });

    expect(result.isStreaming).toBe(true);
    expect(result.modelType).toBe('sortformer');
    expect(result.paths).toEqual({
      model: '/models/diar_streaming_sortformer_4spk/model.onnx',
      metadata: '/models/diar_streaming_sortformer_4spk/metadata.json',
    });
  });

  it('maps sortformer model without metadata when metadata is absent', async () => {
    (SherpaOnnx.detectDiarizationModel as jest.Mock).mockResolvedValue({
      success: true,
      isStreaming: true,
      modelType: 'sortformer',
      detectedModels: [
        {
          type: 'sortformer',
          modelDir: '/models/diar_streaming_sortformer_4spk',
        },
      ],
      paths: {
        model: '/models/diar_streaming_sortformer_4spk/model.onnx',
      },
    });

    const result = await detectDiarizationModel({
      kind: 'fs',
      path: '/models/diar_streaming_sortformer_4spk',
    });

    expect(result.isStreaming).toBe(true);
    expect(result.modelType).toBe('sortformer');
    expect(result.paths).toEqual({
      model: '/models/diar_streaming_sortformer_4spk/model.onnx',
    });
    expect(result.paths?.metadata).toBeUndefined();
  });
});
