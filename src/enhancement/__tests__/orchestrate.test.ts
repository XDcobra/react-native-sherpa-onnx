jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    enhanceOfflineAudioBuffers: jest.fn(),
  },
}));

jest.mock('../../pipeline/offlineOrchestrator', () => ({
  runOfflineAudioPipeline: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { runOfflineAudioPipeline } from '../../pipeline/offlineOrchestrator';
import { runOfflineEnhancementPipeline } from '../orchestrate';

describe('runOfflineEnhancementPipeline', () => {
  const native = SherpaOnnx as unknown as {
    enhanceOfflineAudioBuffers: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.enhanceOfflineAudioBuffers.mockResolvedValue(null);
    (runOfflineAudioPipeline as jest.Mock).mockImplementation(
      async (_input, consumer, _config) => {
        await consumer({ bufferId: 'off_seg_in' }, { bufferId: 'off_seg_out' });
        return {
          status: 'complete',
          totalSegments: 1,
          completedSegments: 1,
          skippedSegments: [],
          processingTimeMs: 5,
          outputBuffer: { bufferId: 'off_final' },
        };
      }
    );
  });

  it('uses offline audio orchestrator with default speech energy policy', async () => {
    await runOfflineEnhancementPipeline('off_input', 'enh_1', {
      segmentation: { mode: 'auto' },
    });

    expect(runOfflineAudioPipeline).toHaveBeenCalledWith(
      'off_input',
      expect.any(Function),
      expect.objectContaining({
        segmentation: {
          mode: 'auto',
          policy: expect.objectContaining({
            evaluator: 'speech_energy_silence',
          }),
        },
      })
    );
    expect(native.enhanceOfflineAudioBuffers).toHaveBeenCalledWith(
      'enh_1',
      'off_seg_in',
      'off_seg_out'
    );
  });

  it('passes recovery and overlap options through to orchestration', async () => {
    const abortController = new AbortController();

    await runOfflineEnhancementPipeline('off_input', 'enh_1', {
      segmentation: {
        mode: 'auto',
        policy: {
          evaluator: 'speech_energy_silence',
          maxSegmentMs: 2000,
        },
      },
      errorRecovery: 'retry',
      maxRetriesPerSegment: 2,
      retryExhaustedFallback: 'skip',
      abortSignal: abortController.signal,
      onProgress: jest.fn(),
      overlapSamples: 160,
    });

    expect(runOfflineAudioPipeline).toHaveBeenCalledWith(
      'off_input',
      expect.any(Function),
      expect.objectContaining({
        errorRecovery: 'retry',
        maxRetriesPerSegment: 2,
        retryExhaustedFallback: 'skip',
        abortSignal: abortController.signal,
        onProgress: expect.any(Function),
        overlapSamples: 160,
      })
    );
  });
});
