jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeOfflinePunctuation: jest.fn(),
    unloadOfflinePunctuation: jest.fn(),
    punctuateOfflineTextBuffers: jest.fn(),
    startPunctuationOfflineLivePipeline: jest.fn(),
    stopStreamingPipeline: jest.fn(),
    flushStreamingPipeline: jest.fn(),
    resetStreamingPipeline: jest.fn(),
    getStreamingPipelineStatus: jest.fn(),
  },
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForModelInit: jest.fn(
    async () => '/models/punctuation-offline'
  ),
}));

const mockSubscribeLiveTextBufferEvents = jest.fn();
jest.mock('../../textbuffer', () => ({
  resolveOfflineTextBufferId: jest.fn((value: unknown) => String(value)),
  resolvePipelineTextBufferId: jest.fn((value: unknown) => String(value)),
  subscribeLiveTextBufferEvents: (...args: unknown[]) =>
    mockSubscribeLiveTextBufferEvents(...args),
  createEmptyOfflineTextBuffer: jest.fn(),
  getOfflineTextBufferTextSlice: jest.fn(),
  getPipelineTextBufferInfo: jest.fn(),
  releasePipelineTextBuffer: jest.fn(),
}));

const mockAttachSegmentationEngine = jest.fn();
const mockGetSegmentationEngineInfo = jest.fn();
const mockDetachSegmentationEngine = jest.fn();
jest.mock('../../segment', () => ({
  attachSegmentationEngine: (...args: unknown[]) =>
    mockAttachSegmentationEngine(...args),
  getSegmentationEngineInfo: (...args: unknown[]) =>
    mockGetSegmentationEngineInfo(...args),
  detachSegmentationEngine: (...args: unknown[]) =>
    mockDetachSegmentationEngine(...args),
}));

const mockCreateStreamingPipelineCompletionPromise = jest.fn();
jest.mock('../../audiobuffer/streamingPipelineCompletion', () => ({
  createStreamingPipelineCompletionPromise: (pipelineId: string) =>
    mockCreateStreamingPipelineCompletionPromise(pipelineId),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createOfflinePunctuation } from '../offline';
import type { PunctuationPipelineHandle } from '../streamingTypes';

describe('offline punctuation live overload', () => {
  const mockNative = SherpaOnnx as unknown as {
    initializeOfflinePunctuation: jest.Mock;
    unloadOfflinePunctuation: jest.Mock;
    startPunctuationOfflineLivePipeline: jest.Mock;
    stopStreamingPipeline: jest.Mock;
    flushStreamingPipeline: jest.Mock;
    resetStreamingPipeline: jest.Mock;
    getStreamingPipelineStatus: jest.Mock;
  };

  let completionResolve: ((value: unknown) => void) | undefined;
  let completionReject: ((reason?: unknown) => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();

    completionResolve = undefined;
    completionReject = undefined;
    mockCreateStreamingPipelineCompletionPromise.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          completionResolve = resolve;
          completionReject = reject;
        })
    );

    mockNative.initializeOfflinePunctuation.mockResolvedValue({
      success: true,
      detectedModels: [],
      modelType: 'ct_transformer',
    });
    mockNative.unloadOfflinePunctuation.mockResolvedValue(null);
    mockNative.startPunctuationOfflineLivePipeline.mockResolvedValue({
      pipelineId: 'punc_pipe_1',
    });
    mockNative.stopStreamingPipeline.mockResolvedValue(undefined);
    mockNative.flushStreamingPipeline.mockResolvedValue(undefined);
    mockNative.resetStreamingPipeline.mockResolvedValue(undefined);
    mockNative.getStreamingPipelineStatus.mockResolvedValue({
      pipelineId: 'punc_pipe_1',
      isRunning: true,
      chunksProcessed: 2,
      unitsRead: 40,
      unitsWritten: 42,
      error: null,
    });

    mockAttachSegmentationEngine.mockResolvedValue({ engineId: 'seg_txt_1' });
    mockGetSegmentationEngineInfo.mockResolvedValue({
      engineId: 'seg_txt_1',
      segmentBufferId: 'seg_live_txt_1',
    });
    mockDetachSegmentationEngine.mockResolvedValue(undefined);

    mockSubscribeLiveTextBufferEvents.mockImplementation(() => jest.fn());
  });

  it('LP-1 starts live offline punctuation with attached segmentation context', async () => {
    const punc = await createOfflinePunctuation({
      modelSource: { kind: 'fs', path: '/models/punctuation-offline' },
    });

    const handle = (await punc.punctuate('txt_live_in_1', 'txt_live_out_1', {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'text_synthetic_auto' },
      },
    })) as unknown as PunctuationPipelineHandle;

    expect(mockAttachSegmentationEngine).toHaveBeenCalledWith('txt_live_in_1', {
      policy: { evaluator: 'text_synthetic_auto' },
    });
    expect(mockGetSegmentationEngineInfo).toHaveBeenCalledWith('seg_txt_1');
    expect(mockNative.startPunctuationOfflineLivePipeline).toHaveBeenCalledWith(
      expect.stringMatching(/^punc_off_/),
      'txt_live_in_1',
      'txt_live_out_1',
      {
        attachedSegmentationEngineId: 'seg_txt_1',
        segmentLiveBufferId: 'seg_live_txt_1',
      }
    );
    expect(handle.pipelineId).toBe('punc_pipe_1');
  });

  it('LP-2 throws when segmentation policy is missing', async () => {
    const punc = await createOfflinePunctuation({
      modelSource: { kind: 'fs', path: '/models/punctuation-offline' },
    });

    await expect(
      punc.punctuate('txt_live_in_1', 'txt_live_out_1', {
        segmentation: undefined,
      })
    ).rejects.toThrow('LIVE_OFFLINE_SEGMENTATION_REQUIRED');
  });

  it('LP-3 rejects speech-domain policy for punctuation live overload', async () => {
    const punc = await createOfflinePunctuation({
      modelSource: { kind: 'fs', path: '/models/punctuation-offline' },
    });

    await expect(
      punc.punctuate('txt_live_in_1', 'txt_live_out_1', {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'speech_energy_silence' },
        },
      })
    ).rejects.toThrow('LIVE_OFFLINE_SEGMENTATION_REQUIRED');
  });

  it('LP-4 rejects text_punctuation_assisted policy without punctuationInstanceId', async () => {
    const punc = await createOfflinePunctuation({
      modelSource: { kind: 'fs', path: '/models/punctuation-offline' },
    });

    await expect(
      punc.punctuate('txt_live_in_1', 'txt_live_out_1', {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'text_punctuation_assisted' },
        },
      } as never)
    ).rejects.toThrow('punctuationInstanceId');
  });

  it('LP-5 rejects mixed offline/live arguments', async () => {
    const punc = await createOfflinePunctuation({
      modelSource: { kind: 'fs', path: '/models/punctuation-offline' },
    });

    await expect(
      punc.punctuate('txt_off_1', 'txt_live_out_1', {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'text_synthetic_auto' },
        },
      } as never)
    ).rejects.toThrow('PUNCTUATION_INVALID_ARGUMENT');
  });

  it('LP-6 handle.flush delegates to native flush', async () => {
    const punc = await createOfflinePunctuation({
      modelSource: { kind: 'fs', path: '/models/punctuation-offline' },
    });
    const handle = (await punc.punctuate('txt_live_in_1', 'txt_live_out_1', {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'text_synthetic_auto' },
      },
    })) as unknown as PunctuationPipelineHandle;

    await handle.flush();
    expect(mockNative.flushStreamingPipeline).toHaveBeenCalledWith(
      'punc_pipe_1'
    );
  });

  it('LP-7 handle.stop delegates to native stop', async () => {
    const punc = await createOfflinePunctuation({
      modelSource: { kind: 'fs', path: '/models/punctuation-offline' },
    });
    const handle = (await punc.punctuate('txt_live_in_1', 'txt_live_out_1', {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'text_synthetic_auto' },
      },
    })) as unknown as PunctuationPipelineHandle;

    await handle.stop();
    expect(mockNative.stopStreamingPipeline).toHaveBeenCalledWith(
      'punc_pipe_1'
    );
  });

  it('LP-8 forwards committed text segments to onSegment callback and unsubscribes on completion', async () => {
    const unsubscribe = jest.fn();
    let onSegmentCb: ((event: { segment: unknown }) => void) | undefined;
    mockSubscribeLiveTextBufferEvents.mockImplementation(
      (
        _bufferId: unknown,
        callbacks: { onSegment?: (event: { segment: unknown }) => void }
      ) => {
        onSegmentCb = callbacks.onSegment;
        return unsubscribe;
      }
    );

    const onSegment = jest.fn();
    const punc = await createOfflinePunctuation({
      modelSource: { kind: 'fs', path: '/models/punctuation-offline' },
    });
    const handle = (await punc.punctuate('txt_live_in_1', 'txt_live_out_1', {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'text_synthetic_auto' },
      },
      onSegment,
    })) as unknown as PunctuationPipelineHandle;

    onSegmentCb?.({ segment: { text: 'Hello, world.' } });
    onSegmentCb?.({ segment: { text: 'Bye.' } });

    expect(onSegment).toHaveBeenCalledTimes(2);

    completionResolve?.({ reason: 'completed' });
    await handle.completed;

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(completionReject).toBeDefined();
  });
});
