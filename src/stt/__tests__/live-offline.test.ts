jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeStt: jest.fn(),
    unloadStt: jest.fn(),
    transcribe: jest.fn(),
    populateOfflineTextBufferIfEmpty: jest.fn(),
    startSttOfflineLivePipeline: jest.fn(),
    stopStreamingPipeline: jest.fn(),
    flushStreamingPipeline: jest.fn(),
    resetStreamingPipeline: jest.fn(),
    getStreamingPipelineStatus: jest.fn(),
  },
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/stt',
    assetName: 'model.onnx',
  })),
  resolveFileSourceForModelInit: jest.fn(async () => ({
    modelDir: '/models/stt',
    assetName: 'model.onnx',
  })),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

const mockSubscribeLiveTextBufferEvents = jest.fn();
jest.mock('../../textbuffer', () => ({
  resolvePipelineTextBufferId: jest.fn((value: unknown) => String(value)),
  subscribeLiveTextBufferEvents: (...args: unknown[]) =>
    mockSubscribeLiveTextBufferEvents(...args),
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
  createSegmentLinkMap: jest.fn(),
  addSegmentLink: jest.fn(),
}));

const mockCreateStreamingPipelineCompletionPromise = jest.fn();
jest.mock('../../audiobuffer/streamingPipelineCompletion', () => ({
  createStreamingPipelineCompletionPromise: (pipelineId: string) =>
    mockCreateStreamingPipelineCompletionPromise(pipelineId),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createSTT } from '../index';
import type { SttPipelineHandle } from '../streamingTypes';

describe('stt live offline overload', () => {
  const mockNative = SherpaOnnx as unknown as {
    initializeStt: jest.Mock;
    unloadStt: jest.Mock;
    startSttOfflineLivePipeline: jest.Mock;
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

    mockNative.initializeStt.mockResolvedValue({
      success: true,
      detectedModels: [],
    });
    mockNative.unloadStt.mockResolvedValue(null);
    mockNative.startSttOfflineLivePipeline.mockResolvedValue({
      pipelineId: 'pipe_1',
    });
    mockNative.stopStreamingPipeline.mockResolvedValue(undefined);
    mockNative.flushStreamingPipeline.mockResolvedValue(undefined);
    mockNative.resetStreamingPipeline.mockResolvedValue(undefined);
    mockNative.getStreamingPipelineStatus.mockResolvedValue({
      pipelineId: 'pipe_1',
      isRunning: true,
      chunksProcessed: 3,
      unitsRead: 3200,
      unitsWritten: 8,
      error: null,
    });

    mockAttachSegmentationEngine.mockResolvedValue({ engineId: 'seg_1' });
    mockGetSegmentationEngineInfo.mockResolvedValue({
      engineId: 'seg_1',
      segmentBufferId: 'seg_live_1',
    });
    mockDetachSegmentationEngine.mockResolvedValue(undefined);

    mockSubscribeLiveTextBufferEvents.mockImplementation(() => jest.fn());
  });

  it('L-1 starts live offline pipeline with attached segmentation context', async () => {
    const stt = await createSTT({
      modelSource: { kind: 'fs', path: '/models/stt' },
    });

    const handle = (await stt.transcribe('live_audio_1', 'txt_live_1', {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'speech_energy_silence' },
      },
    })) as unknown as SttPipelineHandle;

    expect(mockAttachSegmentationEngine).toHaveBeenCalledWith('live_audio_1', {
      policy: { evaluator: 'speech_energy_silence' },
    });
    expect(mockGetSegmentationEngineInfo).toHaveBeenCalledWith('seg_1');
    expect(mockNative.startSttOfflineLivePipeline).toHaveBeenCalledWith(
      expect.stringMatching(/^stt_/),
      'live_audio_1',
      'txt_live_1',
      {
        attachedSegmentationEngineId: 'seg_1',
        segmentLiveBufferId: 'seg_live_1',
      }
    );
    expect(handle.pipelineId).toBe('pipe_1');
  });

  it('L-2 throws when segmentation policy is missing', async () => {
    const stt = await createSTT({
      modelSource: { kind: 'fs', path: '/models/stt' },
    });

    await expect(
      stt.transcribe('live_audio_1', 'txt_live_1', {
        segmentation: undefined,
      })
    ).rejects.toThrow('LIVE_OFFLINE_SEGMENTATION_REQUIRED');
  });

  it('L-3 rejects segmentation.mode off for live overload', async () => {
    const stt = await createSTT({
      modelSource: { kind: 'fs', path: '/models/stt' },
    });

    await expect(
      stt.transcribe('live_audio_1', 'txt_live_1', {
        segmentation: {
          mode: 'off',
          policy: { evaluator: 'speech_energy_silence' },
        },
      })
    ).rejects.toThrow('LIVE_OFFLINE_SEGMENTATION_REQUIRED');
  });

  it('L-4 rejects text-domain policy for speech live overload', async () => {
    const stt = await createSTT({
      modelSource: { kind: 'fs', path: '/models/stt' },
    });

    await expect(
      stt.transcribe('live_audio_1', 'txt_live_1', {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'text_synthetic_auto' },
        },
      })
    ).rejects.toThrow('LIVE_OFFLINE_SEGMENTATION_REQUIRED');
  });

  it('L-5 rejects mixed offline/live arguments', async () => {
    const stt = await createSTT({
      modelSource: { kind: 'fs', path: '/models/stt' },
    });

    await expect(
      stt.transcribe('off_audio_1', 'txt_live_1', {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'speech_energy_silence' },
        },
      } as never)
    ).rejects.toThrow('STT_INVALID_ARGUMENT');
  });

  it('L-6 handle.flush delegates to native flush', async () => {
    const stt = await createSTT({
      modelSource: { kind: 'fs', path: '/models/stt' },
    });
    const handle = (await stt.transcribe('live_audio_1', 'txt_live_1', {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'speech_energy_silence' },
      },
    })) as unknown as SttPipelineHandle;

    await handle.flush();
    expect(mockNative.flushStreamingPipeline).toHaveBeenCalledWith('pipe_1');
  });

  it('L-7 handle.stop delegates to native stop', async () => {
    const stt = await createSTT({
      modelSource: { kind: 'fs', path: '/models/stt' },
    });
    const handle = (await stt.transcribe('live_audio_1', 'txt_live_1', {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'speech_energy_silence' },
      },
    })) as unknown as SttPipelineHandle;

    await handle.stop();
    expect(mockNative.stopStreamingPipeline).toHaveBeenCalledWith('pipe_1');
  });

  it('L-8 forwards committed text segments to onSegment callback and unsubscribes on completion', async () => {
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
    const stt = await createSTT({
      modelSource: { kind: 'fs', path: '/models/stt' },
    });
    const handle = (await stt.transcribe('live_audio_1', 'txt_live_1', {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'speech_energy_silence' },
      },
      onSegment,
    })) as unknown as SttPipelineHandle;

    onSegmentCb?.({ segment: { text: 'hello' } });
    onSegmentCb?.({ segment: { text: 'world' } });

    expect(onSegment).toHaveBeenCalledTimes(2);

    completionResolve?.({ reason: 'completed' });
    await handle.completed;

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(completionReject).toBeDefined();
  });
});
