jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeTts: jest.fn(),
    unloadTts: jest.fn(),
    startTtsOfflineLivePipeline: jest.fn(),
    stopStreamingPipeline: jest.fn(),
    flushStreamingPipeline: jest.fn(),
    resetStreamingPipeline: jest.fn(),
    getStreamingPipelineStatus: jest.fn(),
  },
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/tts',
    assetName: 'model.onnx',
  })),
  resolveFileSourceForModelInit: jest.fn(async () => '/models/tts'),
}));

const mockSubscribeLiveAudioBufferEvents = jest.fn();
jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((value: unknown) =>
    typeof value === 'string' ? value : (value as { bufferId: string }).bufferId
  ),
  subscribeLiveAudioBufferEvents: (...args: unknown[]) =>
    mockSubscribeLiveAudioBufferEvents(...args),
  releasePipelineAudioBuffer: jest.fn(),
}));

jest.mock('../../textbuffer', () => ({
  resolvePipelineTextBufferId: jest.fn((value: unknown) => String(value)),
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
import { createTTS } from '../index';
import type { TtsPipelineHandle } from '../streamingTypes';

describe('tts live offline overload', () => {
  const mockNative = SherpaOnnx as unknown as {
    initializeTts: jest.Mock;
    unloadTts: jest.Mock;
    startTtsOfflineLivePipeline: jest.Mock;
    stopStreamingPipeline: jest.Mock;
    flushStreamingPipeline: jest.Mock;
    resetStreamingPipeline: jest.Mock;
    getStreamingPipelineStatus: jest.Mock;
  };

  let completionResolve: ((value: unknown) => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    completionResolve = undefined;
    mockCreateStreamingPipelineCompletionPromise.mockImplementation(
      () =>
        new Promise((resolve) => {
          completionResolve = resolve;
        })
    );

    mockNative.initializeTts.mockResolvedValue({
      success: true,
      detectedModels: [],
    });
    mockNative.unloadTts.mockResolvedValue(undefined);
    mockNative.startTtsOfflineLivePipeline.mockResolvedValue({
      pipelineId: 'tts_pipe_1',
    });
    mockNative.stopStreamingPipeline.mockResolvedValue(undefined);
    mockNative.flushStreamingPipeline.mockResolvedValue(undefined);
    mockNative.resetStreamingPipeline.mockResolvedValue(undefined);
    mockNative.getStreamingPipelineStatus.mockResolvedValue({
      pipelineId: 'tts_pipe_1',
      isRunning: true,
      chunksProcessed: 2,
      unitsRead: 20,
      unitsWritten: 6400,
      error: null,
    });

    mockAttachSegmentationEngine.mockResolvedValue({ engineId: 'seg_txt_1' });
    mockGetSegmentationEngineInfo.mockResolvedValue({
      engineId: 'seg_txt_1',
      segmentBufferId: 'seg_live_txt_1',
    });
    mockDetachSegmentationEngine.mockResolvedValue(undefined);
    mockSubscribeLiveAudioBufferEvents.mockImplementation(() => jest.fn());
  });

  it('starts live offline pipeline and forwards options', async () => {
    const tts = await createTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });

    const handle = (await tts.synthesize('txt_live_in_1', 'live_out_1', {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'text_synthetic_auto' },
      },
      sid: 5,
      speed: 1.2,
    })) as unknown as TtsPipelineHandle;

    expect(mockNative.startTtsOfflineLivePipeline).toHaveBeenCalledWith(
      expect.stringMatching(/^tts_/),
      'txt_live_in_1',
      'live_out_1',
      expect.objectContaining({
        attachedSegmentationEngineId: 'seg_txt_1',
        segmentLiveBufferId: 'seg_live_txt_1',
        sid: 5,
        speed: 1.2,
      })
    );
    expect(handle.pipelineId).toBe('tts_pipe_1');
  });

  it('rejects missing segmentation policy', async () => {
    const tts = await createTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });
    await expect(
      tts.synthesize('txt_live_in_1', 'live_out_1', {
        segmentation: undefined,
      } as never)
    ).rejects.toThrow('LIVE_OFFLINE_SEGMENTATION_REQUIRED');
  });

  it('maps voiceClone to native bridge fields', async () => {
    const tts = await createTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });

    await tts.synthesize('txt_live_in_1', 'live_out_1', {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'text_synthetic_auto' },
      },
      voiceClone: {
        kind: 'zipvoice',
        referenceAudio: 'off_ref_audio_1',
        referenceText: 'sample ref',
      },
    } as never);

    expect(mockNative.startTtsOfflineLivePipeline).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        referenceAudioBufferId: 'off_ref_audio_1',
        referenceText: 'sample ref',
      })
    );
  });

  it('delegates lifecycle methods through handle', async () => {
    const tts = await createTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });
    const handle = (await tts.synthesize('txt_live_in_1', 'live_out_1', {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'text_synthetic_auto' },
      },
    })) as unknown as TtsPipelineHandle;

    await handle.flush();
    await handle.stop();
    completionResolve?.({ reason: 'completed' });
    await handle.completed;

    expect(mockNative.flushStreamingPipeline).toHaveBeenCalledWith(
      'tts_pipe_1'
    );
    expect(mockNative.stopStreamingPipeline).toHaveBeenCalledWith('tts_pipe_1');
  });
});
