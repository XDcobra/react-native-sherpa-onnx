jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeSpeakerEmbeddingExtractor: jest.fn(),
    unloadSpeakerEmbeddingExtractor: jest.fn(),
    computeSpeakerEmbeddingOffline: jest.fn(),
    createSpeakerEmbeddingManager: jest.fn(),
    destroySpeakerEmbeddingManager: jest.fn(),
    speakerEmbeddingManagerAdd: jest.fn(),
    speakerEmbeddingManagerRemove: jest.fn(),
    speakerEmbeddingManagerSearch: jest.fn(),
    speakerEmbeddingManagerVerify: jest.fn(),
    speakerEmbeddingManagerContains: jest.fn(),
    speakerEmbeddingManagerNumSpeakers: jest.fn(),
    speakerEmbeddingManagerAllSpeakerNames: jest.fn(),
    startSpeakerIdentificationOfflineLivePipeline: jest.fn(),
    stopStreamingPipeline: jest.fn(),
    flushStreamingPipeline: jest.fn(),
    resetStreamingPipeline: jest.fn(),
    getStreamingPipelineStatus: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(
    async () => '/models/speaker-embedding'
  ),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => {
    if (typeof value === 'string') return value;
    if (
      typeof value === 'object' &&
      value != null &&
      'bufferId' in (value as object)
    ) {
      return String((value as { bufferId: string }).bufferId);
    }
    return String(value);
  }),
}));

const mockSubscribeLiveSegmentBufferEvents = jest.fn();
jest.mock('../../segmentbuffer', () => ({
  finalizeLiveSegmentBuffer: jest.fn(async () => undefined),
  resolveLiveSegmentBufferId: jest.fn((value: unknown) => {
    if (typeof value === 'string') return value;
    if (
      typeof value === 'object' &&
      value != null &&
      'bufferId' in (value as object)
    ) {
      return String((value as { bufferId: string }).bufferId);
    }
    return String(value);
  }),
  subscribeLiveSegmentBufferEvents: (...args: unknown[]) =>
    mockSubscribeLiveSegmentBufferEvents(...args),
}));

jest.mock('../../segment', () => ({
  attachSegmentationEngine: jest.fn(),
  detachSegmentationEngine: jest.fn(),
  getSegmentationEngineInfo: jest.fn(),
}));

const mockCreateStreamingPipelineCompletionPromise = jest.fn();
jest.mock('../../audiobuffer/streamingPipelineCompletion', () => ({
  createStreamingPipelineCompletionPromise: (pipelineId: string) =>
    mockCreateStreamingPipelineCompletionPromise(pipelineId),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import * as segment from '../../segment';
import * as segmentbuffer from '../../segmentbuffer';
import { createSpeakerIdentification } from '../index';
import { LIVE_OFFLINE_SEGMENTATION_REQUIRED } from '../../livePipeline';

describe('labelLiveSegments', () => {
  const native = SherpaOnnx as unknown as {
    initializeSpeakerEmbeddingExtractor: jest.Mock;
    unloadSpeakerEmbeddingExtractor: jest.Mock;
    computeSpeakerEmbeddingOffline: jest.Mock;
    createSpeakerEmbeddingManager: jest.Mock;
    destroySpeakerEmbeddingManager: jest.Mock;
    speakerEmbeddingManagerSearch: jest.Mock;
    startSpeakerIdentificationOfflineLivePipeline: jest.Mock;
    stopStreamingPipeline: jest.Mock;
    flushStreamingPipeline: jest.Mock;
    resetStreamingPipeline: jest.Mock;
    getStreamingPipelineStatus: jest.Mock;
  };

  const seg = segment as unknown as {
    attachSegmentationEngine: jest.Mock;
    detachSegmentationEngine: jest.Mock;
    getSegmentationEngineInfo: jest.Mock;
  };

  const segs = segmentbuffer as unknown as {
    finalizeLiveSegmentBuffer: jest.Mock;
  };

  const AUDIO_LIVE = 'live_audio';
  const SEGS_OUT = 'seg_live_out';
  const ENGINE_ID = 'seg_engine_1';
  const SEG_LIVE_INTERNAL = 'seg_live_internal';
  const PIPELINE_ID = 'sid_live_pipe_1';

  const defaultPolicy = { evaluator: 'speech_energy_silence' as const };

  const emb = [0.1, 0.2, 0.3, 0.4];

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

    native.initializeSpeakerEmbeddingExtractor.mockResolvedValue({
      success: true,
      dim: 4,
      modelType: 'wespeaker',
    });
    native.unloadSpeakerEmbeddingExtractor.mockResolvedValue(null);
    native.createSpeakerEmbeddingManager.mockResolvedValue({ success: true });
    native.destroySpeakerEmbeddingManager.mockResolvedValue(null);
    native.computeSpeakerEmbeddingOffline.mockResolvedValue({ embedding: emb });
    native.speakerEmbeddingManagerSearch.mockResolvedValue({ name: '' });
    native.startSpeakerIdentificationOfflineLivePipeline.mockResolvedValue({
      pipelineId: PIPELINE_ID,
    });
    native.stopStreamingPipeline.mockResolvedValue(undefined);
    native.flushStreamingPipeline.mockResolvedValue(undefined);
    native.resetStreamingPipeline.mockResolvedValue(undefined);
    native.getStreamingPipelineStatus.mockResolvedValue({
      pipelineId: PIPELINE_ID,
      isRunning: true,
      chunksProcessed: 0,
      unitsRead: 0,
      unitsWritten: 0,
      error: null,
    });

    seg.attachSegmentationEngine.mockResolvedValue({ engineId: ENGINE_ID });
    seg.getSegmentationEngineInfo.mockResolvedValue({
      engineId: ENGINE_ID,
      attachedBufferId: AUDIO_LIVE,
      domain: 'speech',
      policy: defaultPolicy,
      state: 'active',
      totalSegmentsCommitted: 0,
      segmentBufferId: SEG_LIVE_INTERNAL,
    });
    seg.detachSegmentationEngine.mockResolvedValue(undefined);

    mockSubscribeLiveSegmentBufferEvents.mockImplementation(() => jest.fn());
  });

  it('rejects missing segmentation with LIVE_OFFLINE_SEGMENTATION_REQUIRED', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.labelLiveSegments(AUDIO_LIVE, SEGS_OUT, {} as any)
    ).rejects.toThrow(LIVE_OFFLINE_SEGMENTATION_REQUIRED);
    expect(seg.attachSegmentationEngine).not.toHaveBeenCalled();
  });

  it('rejects segmentation.mode off', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.labelLiveSegments(AUDIO_LIVE, SEGS_OUT, {
        segmentation: { mode: 'off' as any, policy: defaultPolicy },
      })
    ).rejects.toThrow(LIVE_OFFLINE_SEGMENTATION_REQUIRED);
  });

  it('rejects non-live buffers with SID_INVALID_ARGUMENT', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.labelLiveSegments('off_audio' as any, SEGS_OUT, {
        segmentation: { policy: defaultPolicy },
      })
    ).rejects.toThrow(/SID_INVALID_ARGUMENT/);

    await expect(
      sid.labelLiveSegments(AUDIO_LIVE, 'seg_off_out' as any, {
        segmentation: { policy: defaultPolicy },
      })
    ).rejects.toThrow(/SID_INVALID_ARGUMENT/);
  });

  it('rejects non-function onLabeled', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.labelLiveSegments(AUDIO_LIVE, SEGS_OUT, {
        segmentation: { policy: defaultPolicy },
        onLabeled: 1 as any,
      })
    ).rejects.toThrow(/onLabeled must be a function/);
  });

  it('starts native live pipeline with extractor, manager, and segmentation context', async () => {
    const onLabeled = jest.fn();
    let onAppended:
      | ((event: {
          kind: string;
          segmentIndex: number;
          startSample: number;
          endSample: number;
          sampleRate: number;
          durationMs: number;
          confidence?: number;
          payload?: { source: string; speakerName: string | null };
        }) => void)
      | undefined;

    mockSubscribeLiveSegmentBufferEvents.mockImplementation(
      (_id: unknown, callbacks: { onSegmentAppended?: typeof onAppended }) => {
        onAppended = callbacks.onSegmentAppended;
        return jest.fn();
      }
    );

    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    const handle = await sid.labelLiveSegments(AUDIO_LIVE, SEGS_OUT, {
      segmentation: { policy: defaultPolicy },
      threshold: 0.55,
      onLabeled,
    });

    expect(seg.attachSegmentationEngine).toHaveBeenCalledWith(
      AUDIO_LIVE,
      expect.objectContaining({ policy: defaultPolicy })
    );
    expect(
      native.startSpeakerIdentificationOfflineLivePipeline
    ).toHaveBeenCalledWith(
      sid.instanceId,
      sid.managerId,
      AUDIO_LIVE,
      SEGS_OUT,
      {
        attachedSegmentationEngineId: ENGINE_ID,
        segmentLiveBufferId: SEG_LIVE_INTERNAL,
        threshold: 0.55,
      }
    );
    expect(native.computeSpeakerEmbeddingOffline).not.toHaveBeenCalled();
    expect(native.speakerEmbeddingManagerSearch).not.toHaveBeenCalled();
    expect(handle.pipelineId).toBe(PIPELINE_ID);
    expect(handle.instanceId).toBe(sid.instanceId);
    expect(mockSubscribeLiveSegmentBufferEvents).toHaveBeenCalledWith(
      SEGS_OUT,
      expect.objectContaining({ onSegmentAppended: expect.any(Function) })
    );

    onAppended?.({
      kind: 'speech',
      segmentIndex: 0,
      startSample: 0,
      endSample: 1600,
      sampleRate: 16000,
      durationMs: 100,
      confidence: 0.9,
      payload: { source: 'sid', speakerName: 'alice' },
    });
    onAppended?.({
      kind: 'speech',
      segmentIndex: 1,
      startSample: 2000,
      endSample: 3600,
      sampleRate: 16000,
      durationMs: 100,
      payload: { source: 'sid', speakerName: null },
    });

    expect(onLabeled).toHaveBeenCalledTimes(2);
    expect(onLabeled).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        segmentIndex: 0,
        startSample: 0,
        endSample: 1600,
        speakerName: 'alice',
        confidence: 0.9,
      })
    );
    expect(onLabeled).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        segmentIndex: 1,
        speakerName: null,
      })
    );

    completionResolve?.({
      pipelineId: PIPELINE_ID,
      reason: 'completed',
      chunksProcessed: 2,
      unitsRead: 3200,
      unitsWritten: 2,
      error: null,
    });
    await handle.completed;

    expect(seg.detachSegmentationEngine).toHaveBeenCalledWith(ENGINE_ID, {
      flushFinal: true,
    });
    expect(segs.finalizeLiveSegmentBuffer).toHaveBeenCalledWith(SEGS_OUT);
  });

  it('stop() resolves completed with reason stopped and finalizes', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    const handle = await sid.labelLiveSegments(AUDIO_LIVE, SEGS_OUT, {
      segmentation: { policy: defaultPolicy },
    });

    native.stopStreamingPipeline.mockImplementation(async () => {
      completionResolve?.({
        pipelineId: PIPELINE_ID,
        reason: 'stopped',
        chunksProcessed: 1,
        unitsRead: 1600,
        unitsWritten: 1,
        error: null,
      });
    });
    native.getStreamingPipelineStatus.mockResolvedValue({
      pipelineId: PIPELINE_ID,
      isRunning: false,
      chunksProcessed: 1,
      unitsRead: 1600,
      unitsWritten: 1,
      error: null,
    });

    await handle.stop();
    const completion = await handle.completed;
    expect(completion.reason).toBe('stopped');
    expect(native.stopStreamingPipeline).toHaveBeenCalledWith(PIPELINE_ID);
    expect(segs.finalizeLiveSegmentBuffer).toHaveBeenCalledWith(SEGS_OUT);
    expect(seg.detachSegmentationEngine).toHaveBeenCalledWith(ENGINE_ID, {
      flushFinal: true,
    });

    const status = await handle.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.chunksProcessed).toBe(1);
    expect(status.unitsWritten).toBe(1);
  });

  it('getStatus reports counters while running', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    const handle = await sid.labelLiveSegments(AUDIO_LIVE, SEGS_OUT, {
      segmentation: { policy: defaultPolicy },
    });

    const status = await handle.getStatus();
    expect(status).toEqual(
      expect.objectContaining({
        pipelineId: handle.pipelineId,
        isRunning: true,
        chunksProcessed: 0,
        unitsRead: 0,
        unitsWritten: 0,
        error: null,
      })
    );

    native.stopStreamingPipeline.mockImplementation(async () => {
      completionResolve?.({
        pipelineId: PIPELINE_ID,
        reason: 'stopped',
        chunksProcessed: 0,
        unitsRead: 0,
        unitsWritten: 0,
        error: null,
      });
    });
    await handle.stop();
  });

  it('completed rejects when pipeline errors and still finalizes', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    const handle = await sid.labelLiveSegments(AUDIO_LIVE, SEGS_OUT, {
      segmentation: { policy: defaultPolicy },
    });

    const err = Object.assign(new Error('append failed'), {
      code: 'STREAMING_PIPELINE_ERROR',
    });
    completionReject?.(err);

    await expect(handle.completed).rejects.toMatchObject({
      code: 'STREAMING_PIPELINE_ERROR',
      message: expect.stringContaining('append failed'),
    });
    expect(seg.detachSegmentationEngine).toHaveBeenCalledWith(ENGINE_ID, {
      flushFinal: false,
    });
    expect(segs.finalizeLiveSegmentBuffer).toHaveBeenCalledWith(SEGS_OUT);
  });

  it('detaches segmentation engine when segmentBufferId is missing', async () => {
    seg.getSegmentationEngineInfo.mockResolvedValue({
      engineId: ENGINE_ID,
      attachedBufferId: AUDIO_LIVE,
      domain: 'speech',
      policy: defaultPolicy,
      state: 'active',
      totalSegmentsCommitted: 0,
    });

    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.labelLiveSegments(AUDIO_LIVE, SEGS_OUT, {
        segmentation: { policy: defaultPolicy },
      })
    ).rejects.toThrow(/did not produce a segment buffer/);
    expect(seg.detachSegmentationEngine).toHaveBeenCalledWith(ENGINE_ID, {
      flushFinal: false,
    });
    expect(
      native.startSpeakerIdentificationOfflineLivePipeline
    ).not.toHaveBeenCalled();
  });
});
