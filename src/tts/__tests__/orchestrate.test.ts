jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    getTtsSampleRate: jest.fn(),
    synthesizeTts: jest.fn(),
  },
}));

jest.mock('../../pipeline/offlineOrchestrator', () => ({
  runOfflineTextToAudioPipeline: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { runOfflineTextToAudioPipeline } from '../../pipeline/offlineOrchestrator';
import { runOfflineTtsPipeline } from '../orchestrate';

describe('runOfflineTtsPipeline', () => {
  const native = SherpaOnnx as unknown as {
    getTtsSampleRate: jest.Mock;
    synthesizeTts: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.getTtsSampleRate.mockResolvedValue(22050);
    native.synthesizeTts.mockResolvedValue(undefined);
    (runOfflineTextToAudioPipeline as jest.Mock).mockImplementation(
      async (_input, consumer, _config) => {
        await consumer({ bufferId: 'txt_seg' }, { bufferId: 'off_seg' });
        return {
          status: 'complete',
          totalSegments: 1,
          completedSegments: 1,
          skippedSegments: [],
          processingTimeMs: 9,
          outputBuffer: { bufferId: 'off_out' },
          segmentMappings: [
            {
              textSegmentId: 'txt_seg_0',
              speechSegmentId: 'speech_seg_0',
              segmentIndex: 0,
              text: 'hello',
            },
          ],
        };
      }
    );
  });

  it('uses default text_synthetic_auto policy and forwards sample rate', async () => {
    const result = await runOfflineTtsPipeline('txt_off_in', 'tts_1', {
      segmentation: { mode: 'auto' },
      sid: 1,
      speed: 1.1,
    });

    expect(native.getTtsSampleRate).toHaveBeenCalledWith('tts_1');
    expect(runOfflineTextToAudioPipeline).toHaveBeenCalledWith(
      'txt_off_in',
      expect.any(Function),
      expect.objectContaining({
        segmentation: {
          mode: 'auto',
          policy: {
            evaluator: 'text_synthetic_auto',
            sentenceBoundary: true,
            maxLengthChars: 500,
          },
        },
        sampleRate: 22050,
        channels: 1,
      })
    );
    expect(native.synthesizeTts).toHaveBeenCalledWith(
      'tts_1',
      'txt_seg',
      'off_seg',
      expect.objectContaining({ sid: 1, speed: 1.1 })
    );
    expect(result.status).toBe('complete');
  });

  it('passes through custom segmentation and recovery options', async () => {
    await runOfflineTtsPipeline('txt_off_in', 'tts_1', {
      segmentation: {
        mode: 'auto',
        policy: {
          evaluator: 'text_punctuation_assisted',
          punctuationInstanceId: 'punc_1',
          maxLengthChars: 120,
        },
      },
      errorRecovery: 'retry',
      maxRetriesPerSegment: 3,
      retryExhaustedFallback: 'skip',
      overlapChars: 12,
      linkMap: { linkMapId: 'slm_1' },
    });

    expect(runOfflineTextToAudioPipeline).toHaveBeenCalledWith(
      'txt_off_in',
      expect.any(Function),
      expect.objectContaining({
        segmentation: {
          mode: 'auto',
          policy: {
            evaluator: 'text_punctuation_assisted',
            punctuationInstanceId: 'punc_1',
            maxLengthChars: 120,
          },
        },
        errorRecovery: 'retry',
        maxRetriesPerSegment: 3,
        retryExhaustedFallback: 'skip',
        overlapChars: 12,
        linkMap: { linkMapId: 'slm_1' },
      })
    );
  });

  it('rejects non-text policies and punctuation-assisted without instance id', async () => {
    await expect(
      runOfflineTtsPipeline('txt_off_in', 'tts_1', {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'speech_energy_silence' },
        },
      })
    ).rejects.toThrow('requires a text segmentation evaluator');

    await expect(
      runOfflineTtsPipeline('txt_off_in', 'tts_1', {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'text_punctuation_assisted' },
        },
      })
    ).rejects.toThrow('requires policy.punctuationInstanceId');

    expect(runOfflineTextToAudioPipeline).not.toHaveBeenCalled();
  });

  it('rejects manual segmentation mode for offline TTS', async () => {
    await expect(
      runOfflineTtsPipeline('txt_off_in', 'tts_1', {
        segmentation: { mode: 'manual' },
      })
    ).rejects.toThrow('SEGMENTATION_POLICY_INVALID');

    expect(runOfflineTextToAudioPipeline).not.toHaveBeenCalled();
  });

  it('rejects segmentation.policy when mode is off', async () => {
    await expect(
      runOfflineTtsPipeline('txt_off_in', 'tts_1', {
        segmentation: {
          mode: 'off',
          policy: { evaluator: 'text_synthetic_auto' },
        },
      })
    ).rejects.toThrow('SEGMENTATION_POLICY_INVALID');

    expect(runOfflineTextToAudioPipeline).not.toHaveBeenCalled();
  });
});
