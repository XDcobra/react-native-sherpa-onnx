jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeAudioTagging: jest.fn(),
    tagAudioOffline: jest.fn(),
    unloadAudioTagging: jest.fn(),
    detectAudioTaggingModel: jest.fn(),
    getCustomModelPathRequirements: jest.fn(async () => ({
      category: 'audiotagging',
      modelType: 'ced',
      fields: [
        { key: 'model', required: true, description: 'ONNX model' },
        { key: 'labels', required: true, description: 'Labels CSV' },
      ],
    })),
    validateCustomModelPaths: jest.fn(async () => ({
      ok: true,
      category: 'audiotagging',
      modelType: 'ced',
      errors: [],
      missingRequired: [],
      unknownFields: [],
      fields: {},
    })),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(async (source: any) => {
    if (typeof source === 'string') return source;
    return source.path ?? '/resolved/path';
  }),
  resolveModelFileSources: jest.fn(async (map: Record<string, any>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      out[k] = v.path ?? `/resolved/${k}`;
    }
    return out;
  }),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createAudioTagging, AudioTaggingErrorCode } from '../index';

describe('createAudioTagging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('initializes engine successfully using auto modelSource', async () => {
    (SherpaOnnx.initializeAudioTagging as jest.Mock).mockResolvedValue({
      success: true,
      modelType: 'ced',
    });

    const engine = await createAudioTagging({
      modelSource: { kind: 'fs', path: '/models/ced-mini' },
      quantization: 'int8',
      modelType: 'ced',
      numThreads: 2,
      provider: 'cpu',
      topK: 3,
      debug: false,
    });

    expect(engine.instanceId).toMatch(/^audio_tagging_\d+_\d+$/);
    expect(SherpaOnnx.initializeAudioTagging).toHaveBeenCalledWith(
      engine.instanceId,
      {
        initMode: 'auto',
        modelDir: '/models/ced-mini',
        modelType: 'ced',
        quantization: 'int8',
        numThreads: 2,
        provider: 'cpu',
        topK: 3,
        debug: false,
      }
    );
  });

  it('initializes engine successfully using customConfig', async () => {
    (SherpaOnnx.initializeAudioTagging as jest.Mock).mockResolvedValue({
      success: true,
      modelType: 'zipformer',
    });

    const engine = await createAudioTagging({
      initMode: 'custom',
      modelType: 'zipformer',
      customConfig: {
        model: { kind: 'fs', path: '/custom/model.onnx' },
        labels: { kind: 'fs', path: '/custom/class_labels_indices.csv' },
      },
      numThreads: 4,
    });

    expect(engine.instanceId).toBeDefined();
    expect(SherpaOnnx.initializeAudioTagging).toHaveBeenCalledWith(
      engine.instanceId,
      expect.objectContaining({
        initMode: 'custom',
        modelType: 'zipformer',
        modelPaths: {
          model: '/custom/model.onnx',
          labels: '/custom/class_labels_indices.csv',
        },
        numThreads: 4,
      })
    );
  });

  it('rejects if neither modelSource nor customConfig is provided', async () => {
    await expect(createAudioTagging({} as any)).rejects.toThrow(
      AudioTaggingErrorCode.INVALID_ARGUMENT
    );
  });

  it('throws when native init fails', async () => {
    (SherpaOnnx.initializeAudioTagging as jest.Mock).mockResolvedValue({
      success: false,
      error: 'pack missing',
    });

    await expect(
      createAudioTagging({
        modelSource: { kind: 'fs', path: '/models/ced-mini' },
      })
    ).rejects.toThrow(AudioTaggingErrorCode.INIT_FAILED);
  });

  it('destroy unloads native instance', async () => {
    (SherpaOnnx.initializeAudioTagging as jest.Mock).mockResolvedValue({
      success: true,
    });
    (SherpaOnnx.unloadAudioTagging as jest.Mock).mockResolvedValue(undefined);

    const engine = await createAudioTagging({
      modelSource: { kind: 'fs', path: '/models/ced-mini' },
    });
    await engine.destroy();
    expect(SherpaOnnx.unloadAudioTagging).toHaveBeenCalledWith(
      engine.instanceId
    );
  });
});
