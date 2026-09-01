jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    separateOfflineAudioBuffers: jest.fn(),
    getSeparationNumStems: jest.fn(),
  },
}));

jest.mock('../../pipeline/offlineOrchestrator', () => ({
  runOfflineAudioMultiOutputPipeline: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { runOfflineAudioMultiOutputPipeline } from '../../pipeline/offlineOrchestrator';
import { runOfflineSeparationPipeline } from '../orchestrate';

describe('runOfflineSeparationPipeline', () => {
  const native = SherpaOnnx as unknown as {
    separateOfflineAudioBuffers: jest.Mock;
    getSeparationNumStems: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.getSeparationNumStems.mockResolvedValue(2);
    native.separateOfflineAudioBuffers.mockResolvedValue(null);
    (runOfflineAudioMultiOutputPipeline as jest.Mock).mockImplementation(
      async (_input, _outputCount, consumer) => {
        await consumer({ bufferId: 'off_seg_in' }, [
          { bufferId: 'off_seg_out_0' },
          { bufferId: 'off_seg_out_1' },
        ]);
        return {
          status: 'complete',
          totalSegments: 1,
          completedSegments: 1,
          skippedSegments: [],
          processingTimeMs: 5,
          outputBuffer: [
            { bufferId: 'off_final_0' },
            { bufferId: 'off_final_1' },
          ],
        };
      }
    );
  });

  it('uses multi-output orchestrator with default speech energy policy', async () => {
    const result = await runOfflineSeparationPipeline(
      'off_input',
      'sep_1',
      ['off_vocals', 'off_accomp'],
      { segmentation: { mode: 'auto' } }
    );

    expect(result.status).toBe('complete');
    expect(result.outputBuffers).toHaveLength(2);
    expect(runOfflineAudioMultiOutputPipeline).toHaveBeenCalledWith(
      'off_input',
      2,
      expect.any(Function),
      expect.objectContaining({
        segmentation: {
          mode: 'auto',
          policy: expect.objectContaining({
            evaluator: 'speech_energy_silence',
            maxSegmentMs: 120000,
          }),
        },
      })
    );
    expect(native.separateOfflineAudioBuffers).toHaveBeenCalledWith(
      'sep_1',
      'off_seg_in',
      ['off_seg_out_0', 'off_seg_out_1']
    );
  });

  it('passes recovery and overlap options through to orchestration', async () => {
    await runOfflineSeparationPipeline(
      'off_input',
      'sep_1',
      ['off_vocals', 'off_accomp'],
      {
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
        onProgress: jest.fn(),
        overlapSamples: 441,
      }
    );

    expect(runOfflineAudioMultiOutputPipeline).toHaveBeenCalledWith(
      'off_input',
      2,
      expect.any(Function),
      expect.objectContaining({
        errorRecovery: 'retry',
        maxRetriesPerSegment: 2,
        retryExhaustedFallback: 'skip',
        onProgress: expect.any(Function),
        overlapSamples: 441,
      })
    );
  });

  it('throws when audioOuts length does not match numStems', async () => {
    await expect(
      runOfflineSeparationPipeline('off_input', 'sep_1', ['off_vocals'], {
        segmentation: { mode: 'auto' },
      })
    ).rejects.toThrow(/expects 2 output buffers, got 1/);
    expect(runOfflineAudioMultiOutputPipeline).not.toHaveBeenCalled();
  });
});
