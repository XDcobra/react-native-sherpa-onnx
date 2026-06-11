jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeSeparation: jest.fn(),
    unloadSeparation: jest.fn(),
    separateOfflineAudioBuffers: jest.fn(),
    populateOfflineAudioBufferIfEmpty: jest.fn(),
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
  releasePipelineAudioBuffer: jest.fn(),
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

jest.mock('../orchestrate', () => ({
  runOfflineSeparationDirect: jest.fn(),
  runOfflineSeparationPipeline: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { releasePipelineAudioBuffer } from '../../audiobuffer';
import { createSeparation } from '../index';
import {
  runOfflineSeparationDirect,
  runOfflineSeparationPipeline,
} from '../orchestrate';
import { SeparationErrorCode } from '../customConfig';

describe('createSeparation', () => {
  const native = SherpaOnnx as unknown as {
    initializeSeparation: jest.Mock;
    unloadSeparation: jest.Mock;
    separateOfflineAudioBuffers: jest.Mock;
    populateOfflineAudioBufferIfEmpty: jest.Mock;
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
    native.populateOfflineAudioBufferIfEmpty.mockResolvedValue(null);
    native.getSeparationSampleRate.mockResolvedValue(44100);
    native.getSeparationNumStems.mockResolvedValue(2);
    (runOfflineSeparationDirect as jest.Mock).mockResolvedValue(undefined);
    (releasePipelineAudioBuffer as jest.Mock).mockResolvedValue(undefined);
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
    expect(runOfflineSeparationDirect).toHaveBeenCalledWith(
      sep.instanceId,
      'off_input',
      ['off_vocals', 'off_accomp']
    );
    expect(runOfflineSeparationPipeline).not.toHaveBeenCalled();
    expect(native.populateOfflineAudioBufferIfEmpty).not.toHaveBeenCalled();
  });

  it('runs segmented orchestration and populates caller-owned stem buffers', async () => {
    (runOfflineSeparationPipeline as jest.Mock).mockResolvedValue({
      status: 'complete',
      totalSegments: 2,
      completedSegments: 2,
      skippedSegments: [],
      processingTimeMs: 12,
      outputBuffers: [
        { bufferId: 'off_orchestrated_vocals' },
        { bufferId: 'off_orchestrated_accomp' },
      ],
    });

    const sep = await createSeparation({
      modelSource: { kind: 'fs', path: '/models/separation' },
    });

    const result = await sep.separate(
      'off_input',
      ['off_vocals', 'off_accomp'],
      {
        segmentation: { mode: 'auto' },
      }
    );

    expect(result.status).toBe('complete');
    expect(result.totalSegments).toBe(2);
    expect(runOfflineSeparationPipeline).toHaveBeenCalledWith(
      'off_input',
      sep.instanceId,
      ['off_vocals', 'off_accomp'],
      { segmentation: { mode: 'auto' } }
    );
    expect(native.populateOfflineAudioBufferIfEmpty).toHaveBeenCalledWith(
      'off_vocals',
      'off_orchestrated_vocals',
      undefined
    );
    expect(native.populateOfflineAudioBufferIfEmpty).toHaveBeenCalledWith(
      'off_accomp',
      'off_orchestrated_accomp',
      undefined
    );
    expect(releasePipelineAudioBuffer).toHaveBeenCalledWith(
      'off_orchestrated_vocals'
    );
    expect(releasePipelineAudioBuffer).toHaveBeenCalledWith(
      'off_orchestrated_accomp'
    );
    expect(runOfflineSeparationDirect).not.toHaveBeenCalled();
  });

  it('propagates partial orchestration status', async () => {
    (runOfflineSeparationPipeline as jest.Mock).mockResolvedValue({
      status: 'partial',
      totalSegments: 3,
      completedSegments: 1,
      skippedSegments: [],
      failedSegment: {
        segmentIndex: 1,
        segmentId: 'speech_1',
        error: 'boom',
        retryCount: 0,
      },
      processingTimeMs: 9,
      outputBuffers: [
        { bufferId: 'off_partial_v' },
        { bufferId: 'off_partial_a' },
      ],
    });

    const sep = await createSeparation({
      modelSource: { kind: 'fs', path: '/models/separation' },
    });

    const result = await sep.separate(
      'off_input',
      ['off_vocals', 'off_accomp'],
      { segmentation: { mode: 'auto' } }
    );

    expect(result.status).toBe('partial');
    expect(result.failedSegment?.segmentId).toBe('speech_1');
  });

  it('validates output buffer count against numStems', async () => {
    const sep = await createSeparation({
      modelSource: { kind: 'fs', path: '/models/separation' },
    });

    await expect(sep.separate('off_input', ['off_vocals'])).rejects.toThrow(
      `${SeparationErrorCode.INVALID_ARGUMENT}: separate() expects 2 output buffers, got 1`
    );
    expect(runOfflineSeparationDirect).not.toHaveBeenCalled();
    expect(runOfflineSeparationPipeline).not.toHaveBeenCalled();
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
