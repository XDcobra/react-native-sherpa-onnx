jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeEnhancement: jest.fn(),
    unloadEnhancement: jest.fn(),
    enhanceOfflineAudioBuffers: jest.fn(),
    enhancementSetVoiceSample: jest.fn(),
    initializeOnlineEnhancement: jest.fn(),
    unloadOnlineEnhancement: jest.fn(),
    getEnhancementSampleRate: jest.fn(),
    startEnhancementPipeline: jest.fn(),
  },
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/enhancement',
    assetName: 'model.onnx',
  })),
  resolveFileSourceForModelInit: jest.fn(async () => '/models/enhancement'),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => []),
  readPublicLanguageRows: jest.fn(() => []),
}));

jest.mock('../../audiobuffer', () => ({
  releasePipelineAudioBuffer: jest.fn(),
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => {
    if (value && typeof value === 'object' && 'bufferId' in (value as object)) {
      return String((value as { bufferId: string }).bufferId);
    }
    return String(value);
  }),
}));

jest.mock('../orchestrate', () => ({
  runOfflineEnhancementPipeline: jest.fn(),
}));

jest.mock('../../audiobuffer/streamingPipelineCompletion', () => ({
  createStreamingPipelineCompletionPromise: jest.fn(
    () => new Promise(() => {})
  ),
}));

jest.mock('../../segment', () => ({
  attachSegmentationEngine: jest.fn(),
  detachSegmentationEngine: jest.fn(),
  getSegmentationEngineInfo: jest.fn(),
}));

import type { OfflineAudioBufferRef } from '../../audiobuffer/types';
import SherpaOnnx from '../../NativeSherpaOnnx';
import { createEnhancement } from '../index';
import { createStreamingEnhancement } from '../streaming';

function rejectWith(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('setVoiceSample', () => {
  const native = SherpaOnnx as unknown as {
    initializeEnhancement: jest.Mock;
    unloadEnhancement: jest.Mock;
    enhancementSetVoiceSample: jest.Mock;
    initializeOnlineEnhancement: jest.Mock;
    unloadOnlineEnhancement: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.initializeEnhancement.mockResolvedValue({
      success: true,
      detectedModels: [],
    });
    native.unloadEnhancement.mockResolvedValue(null);
    native.enhancementSetVoiceSample.mockResolvedValue(undefined);
    native.initializeOnlineEnhancement.mockResolvedValue({
      success: true,
      frameShiftInSamples: 256,
    });
    native.unloadOnlineEnhancement.mockResolvedValue(null);
  });

  it('forwards the offline buffer id to the native bridge', async () => {
    const engine = await createEnhancement({
      modelSource: { kind: 'fs', path: '/models/voxlock' },
      modelType: 'voxlock',
    });

    await engine.setVoiceSample('off_voice');

    expect(native.enhancementSetVoiceSample).toHaveBeenCalledWith(
      expect.stringMatching(/^enhancement_/),
      'off_voice'
    );
  });

  it('forwards OfflineAudioBuffer handle bufferId', async () => {
    const engine = await createEnhancement({
      modelSource: { kind: 'fs', path: '/models/voxlock' },
      modelType: 'voxlock',
    });

    await engine.setVoiceSample({
      bufferId: 'off_from_handle',
    } as OfflineAudioBufferRef);

    expect(native.enhancementSetVoiceSample).toHaveBeenCalledWith(
      expect.stringMatching(/^enhancement_/),
      'off_from_handle'
    );
  });

  it('does not expose setVoiceSample on a GTCRN engine', async () => {
    const engine = await createEnhancement({
      modelSource: { kind: 'fs', path: '/models/gtcrn' },
      modelType: 'gtcrn',
    });

    expect('setVoiceSample' in engine).toBe(false);
  });

  it('propagates too-short ENHANCEMENT_INVALID_ARGUMENT', async () => {
    native.enhancementSetVoiceSample.mockRejectedValue(
      rejectWith(
        'ENHANCEMENT_INVALID_ARGUMENT',
        'VoxLock voice sample is too short after resample (need 3 seconds)'
      )
    );
    const engine = await createEnhancement({
      modelSource: { kind: 'fs', path: '/models/voxlock' },
      modelType: 'voxlock',
    });

    await expect(engine.setVoiceSample('off_short')).rejects.toMatchObject({
      code: 'ENHANCEMENT_INVALID_ARGUMENT',
    });
  });

  it('propagates empty buffer ENHANCEMENT_BUFFER_EMPTY', async () => {
    native.enhancementSetVoiceSample.mockRejectedValue(
      rejectWith(
        'ENHANCEMENT_BUFFER_EMPTY',
        'Input offline audio buffer is empty: off_empty'
      )
    );
    const engine = await createEnhancement({
      modelSource: { kind: 'fs', path: '/models/voxlock' },
      modelType: 'voxlock',
    });

    await expect(engine.setVoiceSample('off_empty')).rejects.toMatchObject({
      code: 'ENHANCEMENT_BUFFER_EMPTY',
    });
  });

  it('streaming engine forwards the buffer id', async () => {
    const engine = await createStreamingEnhancement({
      modelSource: { kind: 'fs', path: '/models/voxlock' },
      modelType: 'voxlock',
    });

    await engine.setVoiceSample('off_voice');

    expect(native.enhancementSetVoiceSample).toHaveBeenCalledWith(
      expect.stringMatching(/^streaming_enhancement_/),
      'off_voice'
    );
  });

  it('create with voiceSample forwards the buffer id', async () => {
    const engine = await createEnhancement({
      modelSource: { kind: 'fs', path: '/models/voxlock' },
      modelType: 'voxlock',
      voiceSample: 'off_voice',
    });

    expect(native.enhancementSetVoiceSample).toHaveBeenCalledWith(
      engine.instanceId,
      'off_voice'
    );
    expect(native.unloadEnhancement).not.toHaveBeenCalled();
  });

  it('unloads the instance when init voiceSample fails', async () => {
    native.enhancementSetVoiceSample.mockRejectedValue(
      rejectWith(
        'ENHANCEMENT_INVALID_ARGUMENT',
        'VoxLock voice sample is too short after resample (need 3 seconds)'
      )
    );

    await expect(
      createEnhancement({
        modelSource: { kind: 'fs', path: '/models/voxlock' },
        modelType: 'voxlock',
        voiceSample: 'off_short',
      })
    ).rejects.toMatchObject({
      code: 'ENHANCEMENT_INVALID_ARGUMENT',
    });
    expect(native.unloadEnhancement).toHaveBeenCalledWith(
      expect.stringMatching(/^enhancement_/)
    );
  });

  it('streaming create with voiceSample forwards the buffer id', async () => {
    const engine = await createStreamingEnhancement({
      modelSource: { kind: 'fs', path: '/models/voxlock' },
      modelType: 'voxlock',
      voiceSample: 'off_voice',
    });

    expect(native.enhancementSetVoiceSample).toHaveBeenCalledWith(
      engine.instanceId,
      'off_voice'
    );
    expect(native.unloadOnlineEnhancement).not.toHaveBeenCalled();
  });
});
