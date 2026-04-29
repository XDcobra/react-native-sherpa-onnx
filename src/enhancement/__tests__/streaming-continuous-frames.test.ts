jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeOnlineEnhancement: jest.fn(),
    unloadOnlineEnhancement: jest.fn(),
    getEnhancementSampleRate: jest.fn(),
    startEnhancementPipeline: jest.fn(),
    stopStreamingPipeline: jest.fn(),
    flushStreamingPipeline: jest.fn(),
    resetStreamingPipeline: jest.fn(),
    getStreamingPipelineStatus: jest.fn(),
  },
}));

jest.mock('../../utils', () => ({
  resolveModelPath: jest.fn(async () => '/models/enhancement'),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

jest.mock('../../audiobuffer/streamingPipelineCompletion', () => ({
  createStreamingPipelineCompletionPromise: jest.fn(
    () => new Promise(() => {})
  ),
}));

jest.mock('../../segment', () => ({
  attachSegmentationEngine: jest.fn(),
  detachSegmentationEngine: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import {
  attachSegmentationEngine,
  detachSegmentationEngine,
} from '../../segment';
import { createStreamingEnhancement } from '../streaming';

describe('streaming enhancement continuous_frames attach', () => {
  const native = SherpaOnnx as unknown as {
    initializeOnlineEnhancement: jest.Mock;
    unloadOnlineEnhancement: jest.Mock;
    startEnhancementPipeline: jest.Mock;
    stopStreamingPipeline: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.initializeOnlineEnhancement.mockResolvedValue({
      success: true,
      frameShiftInSamples: 256,
    });
    native.unloadOnlineEnhancement.mockResolvedValue(null);
    native.startEnhancementPipeline.mockResolvedValue({
      pipelineId: 'enh_pipe_1',
    });
    native.stopStreamingPipeline.mockResolvedValue(null);
    (attachSegmentationEngine as jest.Mock).mockResolvedValue({
      engineId: 'eng_continuous_1',
    });
    (detachSegmentationEngine as jest.Mock).mockResolvedValue(undefined);
  });

  it('attaches continuous_frames policy before starting enhancement pipeline', async () => {
    const enhancement = await createStreamingEnhancement({
      modelPath: { type: 'file', path: '/models/enhancement' },
    });

    const handle = await enhancement.enhance('live_input', 'live_output', {
      segmentation: {
        mode: 'auto',
        policy: {
          evaluator: 'continuous_frames',
          checkpointIntervalMs: 250,
        },
      },
    });

    expect(attachSegmentationEngine).toHaveBeenCalledWith('live_input', {
      policy: {
        evaluator: 'continuous_frames',
        checkpointIntervalMs: 250,
      },
    });
    expect(native.startEnhancementPipeline).toHaveBeenCalledWith(
      expect.stringMatching(/^streaming_enhancement_/),
      'live_input',
      'live_output'
    );

    await handle.stop();

    expect(native.stopStreamingPipeline).toHaveBeenCalledWith('enh_pipe_1');
    expect(detachSegmentationEngine).toHaveBeenCalledWith('eng_continuous_1', {
      flushFinal: true,
    });
  });

  it('uses continuous_frames default policy when segmentation mode is enabled without policy', async () => {
    const enhancement = await createStreamingEnhancement({
      modelPath: { type: 'file', path: '/models/enhancement' },
    });

    await enhancement.enhance('live_input', 'live_output', {
      segmentation: { mode: 'auto' },
    });

    expect(attachSegmentationEngine).toHaveBeenCalledWith('live_input', {
      policy: {
        evaluator: 'continuous_frames',
        checkpointIntervalMs: 1000,
      },
    });
  });

  it('rejects non-continuous streaming segmentation policies without starting native pipeline', async () => {
    const enhancement = await createStreamingEnhancement({
      modelPath: { type: 'file', path: '/models/enhancement' },
    });

    await expect(
      enhancement.enhance('live_input', 'live_output', {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'speech_energy_silence' },
        },
      })
    ).rejects.toThrow('supports only continuous_frames');

    expect(attachSegmentationEngine).not.toHaveBeenCalled();
    expect(native.startEnhancementPipeline).not.toHaveBeenCalled();
  });
});
