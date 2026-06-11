jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeSeparation: jest.fn(),
    unloadSeparation: jest.fn(),
    separateOfflineAudioBuffers: jest.fn(),
    getSeparationSampleRate: jest.fn(),
    getSeparationNumStems: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/separation',
    assetName: 'model.onnx',
  })),
  resolveFileSourceForModelInit: jest.fn(async () => '/models/separation'),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => []),
  readPublicLanguageRows: jest.fn(() => []),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createSeparation } from '../index';
import { SeparationErrorCode } from '../customConfig';

describe('createSeparation', () => {
  const native = SherpaOnnx as unknown as {
    initializeSeparation: jest.Mock;
    unloadSeparation: jest.Mock;
    separateOfflineAudioBuffers: jest.Mock;
    getSeparationSampleRate: jest.Mock;
    getSeparationNumStems: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.initializeSeparation.mockResolvedValue({
      success: true,
      detectedModels: [],
      modelType: 'uvr',
      sampleRate: 44100,
      numStems: 2,
    });
    native.unloadSeparation.mockResolvedValue(null);
    native.separateOfflineAudioBuffers.mockResolvedValue(null);
    native.getSeparationSampleRate.mockResolvedValue(44100);
    native.getSeparationNumStems.mockResolvedValue(2);
  });

  it('initializes native separation and returns an engine', async () => {
    const sep = await createSeparation({
      modelSource: { kind: 'fs', path: '/models/separation' },
    });

    expect(sep.instanceId).toMatch(/^separation_/);
    expect(native.initializeSeparation).toHaveBeenCalledWith(
      sep.instanceId,
      expect.objectContaining({
        initMode: 'auto',
        modelDir: '/models/separation',
        modelType: 'auto',
      })
    );
    await sep.destroy();
    expect(native.unloadSeparation).toHaveBeenCalledWith(sep.instanceId);
  });

  it('throws when native init fails', async () => {
    native.initializeSeparation.mockResolvedValue({
      success: false,
      error: 'model not found',
      detectedModels: [],
    });

    await expect(
      createSeparation({
        modelSource: { kind: 'fs', path: '/models/missing' },
      })
    ).rejects.toThrow('Separation initialization failed: model not found');
  });

  it('uses direct batch path when segmentation is off', async () => {
    const sep = await createSeparation({
      modelSource: { kind: 'fs', path: '/models/separation' },
    });

    const result = await sep.separate('off_input', [
      'off_vocals',
      'off_accomp',
    ]);

    expect(result).toMatchObject({
      status: 'complete',
      totalSegments: 1,
      completedSegments: 1,
      skippedSegments: [],
    });
    expect(native.separateOfflineAudioBuffers).toHaveBeenCalledWith(
      sep.instanceId,
      'off_input',
      ['off_vocals', 'off_accomp']
    );
  });

  it('rejects unsupported segmentation modes in MVP', async () => {
    const sep = await createSeparation({
      modelSource: { kind: 'fs', path: '/models/separation' },
    });

    await expect(
      sep.separate('off_input', ['off_vocals', 'off_accomp'], {
        segmentation: { mode: 'auto' },
      })
    ).rejects.toThrow(
      `${SeparationErrorCode.INVALID_ARGUMENT}: segmentation mode 'auto' is not supported yet`
    );
    expect(native.separateOfflineAudioBuffers).not.toHaveBeenCalled();
  });

  it('validates output buffer count against numStems', async () => {
    const sep = await createSeparation({
      modelSource: { kind: 'fs', path: '/models/separation' },
    });

    await expect(sep.separate('off_input', ['off_vocals'])).rejects.toThrow(
      `${SeparationErrorCode.INVALID_ARGUMENT}: separate() expects 2 output buffers, got 1`
    );
    expect(native.separateOfflineAudioBuffers).not.toHaveBeenCalled();
  });

  it('guards methods after destroy', async () => {
    const sep = await createSeparation({
      modelSource: { kind: 'fs', path: '/models/separation' },
    });
    await sep.destroy();

    await expect(sep.getSampleRate()).rejects.toThrow(/has been destroyed/);
    await expect(
      sep.separate('off_input', ['off_vocals', 'off_accomp'])
    ).rejects.toThrow(/has been destroyed/);
  });
});
