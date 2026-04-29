jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    punctuateOfflineTextBuffers: jest.fn(),
  },
}));

jest.mock('../../pipeline/offlineOrchestrator', () => ({
  runOfflineTextPipeline: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { runOfflineTextPipeline } from '../../pipeline/offlineOrchestrator';
import { runOfflinePunctuationPipeline } from '../orchestrate';

describe('runOfflinePunctuationPipeline', () => {
  const native = SherpaOnnx as unknown as {
    punctuateOfflineTextBuffers: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.punctuateOfflineTextBuffers.mockResolvedValue({
      processingTimeMs: 1,
    });
    (runOfflineTextPipeline as jest.Mock).mockResolvedValue({
      status: 'complete',
      totalSegments: 1,
      completedSegments: 1,
      skippedSegments: [],
      processingTimeMs: 3,
      outputBuffer: { bufferId: 'txt_tmp' },
    });
  });

  it('uses text_synthetic_auto as the default segmented policy', async () => {
    await runOfflinePunctuationPipeline('txt_off_in', 'punc_off_1', {
      segmentation: { mode: 'auto' },
    });

    expect(runOfflineTextPipeline).toHaveBeenCalledWith(
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
      })
    );
  });

  it('passes recovery, overlap and policy overrides through to the text orchestrator', async () => {
    const linkMap = { linkMapId: 'link_map_1' };
    await runOfflinePunctuationPipeline('txt_off_in', 'punc_off_1', {
      segmentation: {
        mode: 'auto',
        policy: {
          evaluator: 'text_punctuation_assisted',
          punctuationInstanceId: 'punc_on_1',
        },
      },
      errorRecovery: 'skip',
      maxRetriesPerSegment: 2,
      retryExhaustedFallback: 'skip',
      overlapChars: 16,
      textSkipPlaceholder: '[skip]',
      linkMap,
    });

    expect(runOfflineTextPipeline).toHaveBeenCalledWith(
      'txt_off_in',
      expect.any(Function),
      expect.objectContaining({
        segmentation: expect.objectContaining({
          policy: expect.objectContaining({
            evaluator: 'text_punctuation_assisted',
            punctuationInstanceId: 'punc_on_1',
          }),
        }),
        errorRecovery: 'skip',
        maxRetriesPerSegment: 2,
        retryExhaustedFallback: 'skip',
        overlapChars: 16,
        textSkipPlaceholder: '[skip]',
        linkMap,
      })
    );
  });

  it('wires the segment consumer to native punctuateOfflineTextBuffers', async () => {
    await runOfflinePunctuationPipeline('txt_off_in', 'punc_off_1', {
      segmentation: { mode: 'auto' },
    });

    const consumer = (runOfflineTextPipeline as jest.Mock).mock.calls[0][1];
    await consumer({ bufferId: 'txt_seg_in' }, { bufferId: 'txt_seg_out' });

    expect(native.punctuateOfflineTextBuffers).toHaveBeenCalledWith(
      'punc_off_1',
      'txt_seg_in',
      'txt_seg_out'
    );
  });
});
