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
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(
    async () => '/models/speaker-embedding'
  ),
}));

jest.mock('../../audiobuffer', () => ({
  createOfflineAudioBufferFromSamples: jest.fn((samples: Float32Array) => ({
    bufferId: `off_temp_${samples.length}`,
  })),
  getOfflineAudioBufferSamplesSlice: jest.fn(
    () => new Float32Array([0.1, 0.2, 0.3, 0.4])
  ),
  getLiveAudioBufferSamplesSlice: jest.fn(
    () => new Float32Array([0.1, 0.2, 0.3, 0.4])
  ),
  getPipelineAudioBufferInfo: jest.fn(async () => ({
    bufferId: 'live_audio',
    kind: 'livePcmBuffer',
    state: 'recording',
    sampleRate: 16000,
    channelCount: 1,
    numSamples: 0,
    durationMs: 0,
    totalSamplesWritten: 0,
    ringEvictedSamples: 0,
    hasActiveSpool: false,
  })),
  releasePipelineAudioBuffer: jest.fn(async () => undefined),
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

jest.mock('../../segmentbuffer', () => ({
  getOfflineSegmentBufferSegments: jest.fn(),
  createLiveSegmentBuffer: jest.fn(),
  appendLiveSegment: jest.fn(),
  finalizeLiveSegmentBuffer: jest.fn(),
  populateOfflineSegmentBufferIfEmpty: jest.fn(),
  releasePipelineSegmentBuffer: jest.fn(),
  resolveOfflineSegmentBufferId: jest.fn((value: unknown) => String(value)),
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
  getLiveSegmentBufferSegmentCount: jest.fn(),
  getLiveSegmentBufferSegments: jest.fn(),
}));

jest.mock('../../segment', () => ({
  attachSegmentationEngine: jest.fn(),
  detachSegmentationEngine: jest.fn(),
  getSegmentationEngineInfo: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import * as audiobuffer from '../../audiobuffer';
import * as segment from '../../segment';
import * as segmentbuffer from '../../segmentbuffer';
import { __resetSpeakerEmbeddingEngineCacheForTests } from '../../speaker-embedding/engineCache';
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
  };

  const segs = segmentbuffer as unknown as {
    appendLiveSegment: jest.Mock;
    finalizeLiveSegmentBuffer: jest.Mock;
    resolveLiveSegmentBufferId: jest.Mock;
    getLiveSegmentBufferSegmentCount: jest.Mock;
    getLiveSegmentBufferSegments: jest.Mock;
  };

  const seg = segment as unknown as {
    attachSegmentationEngine: jest.Mock;
    detachSegmentationEngine: jest.Mock;
    getSegmentationEngineInfo: jest.Mock;
  };

  const AUDIO_LIVE = 'live_123e4567-e89b-12d3-a456-426614174000';
  const SEGS_OUT = 'seg_live_223e4567-e89b-12d3-a456-426614174000';
  const INTERNAL_SEGS = 'seg_live_323e4567-e89b-12d3-a456-426614174000';
  const ENGINE_ID = 'seg_engine_1';
  const emb = [1, 2, 3, 4];

  const defaultPolicy = {
    evaluator: 'speech_energy_silence' as const,
    silenceThresholdMs: 500,
    energyThresholdDb: -40,
    minSegmentMs: 1000,
    maxSegmentMs: 120000,
    hangoverMs: 300,
  };

  const speechSpan = (start: number, end: number, durationMs = 100) => ({
    id: `s_${start}`,
    kind: 'speech' as const,
    sourceAudioBufferId: AUDIO_LIVE,
    startSample: start,
    endSample: end,
    sampleRate: 16000,
    durationMs,
    confidence: 0.9,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    __resetSpeakerEmbeddingEngineCacheForTests();

    native.initializeSpeakerEmbeddingExtractor.mockResolvedValue({
      success: true,
      dim: 4,
      modelType: 'wespeaker',
    });
    native.unloadSpeakerEmbeddingExtractor.mockResolvedValue(null);
    native.computeSpeakerEmbeddingOffline.mockResolvedValue({ embedding: emb });
    native.createSpeakerEmbeddingManager.mockResolvedValue({ success: true });
    native.destroySpeakerEmbeddingManager.mockResolvedValue(null);
    native.speakerEmbeddingManagerSearch.mockResolvedValue({ name: 'alice' });

    seg.attachSegmentationEngine.mockResolvedValue({ engineId: ENGINE_ID });
    seg.getSegmentationEngineInfo.mockResolvedValue({
      engineId: ENGINE_ID,
      attachedBufferId: AUDIO_LIVE,
      domain: 'speech',
      policy: defaultPolicy,
      state: 'active',
      totalSegmentsCommitted: 0,
      segmentBufferId: INTERNAL_SEGS,
    });
    seg.detachSegmentationEngine.mockResolvedValue(undefined);

    segs.appendLiveSegment.mockResolvedValue({
      segmentId: 'labeled_1',
      segmentIndex: 0,
    });
    segs.finalizeLiveSegmentBuffer.mockResolvedValue(undefined);
    segs.getLiveSegmentBufferSegmentCount.mockResolvedValue(0);
    segs.getLiveSegmentBufferSegments.mockResolvedValue([]);

    (audiobuffer.getPipelineAudioBufferInfo as jest.Mock).mockResolvedValue({
      bufferId: AUDIO_LIVE,
      kind: 'livePcmBuffer',
      state: 'recording',
      sampleRate: 16000,
      channelCount: 1,
      numSamples: 0,
      durationMs: 0,
      totalSamplesWritten: 0,
      ringEvictedSamples: 0,
      hasActiveSpool: false,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
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

  it('rejects non-function onLabeled / onError', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.labelLiveSegments(AUDIO_LIVE, SEGS_OUT, {
        segmentation: { policy: defaultPolicy },
        onLabeled: 1 as any,
      })
    ).rejects.toThrow(/onLabeled must be a function/);

    await expect(
      sid.labelLiveSegments(AUDIO_LIVE, SEGS_OUT, {
        segmentation: { policy: defaultPolicy },
        onError: 1 as any,
      })
    ).rejects.toThrow(/onError must be a function/);
  });

  it('labels committed spans: extract → search → append → onLabeled', async () => {
    const spans = [speechSpan(0, 1600), speechSpan(2000, 3600, 200)];
    let committed = 0;
    segs.getLiveSegmentBufferSegmentCount.mockImplementation(async () => {
      return committed;
    });
    segs.getLiveSegmentBufferSegments.mockImplementation(
      async (_id: string, start: number, max: number) => {
        return spans.slice(start, start + max);
      }
    );
    native.speakerEmbeddingManagerSearch
      .mockResolvedValueOnce({ name: 'alice' })
      .mockResolvedValueOnce({ name: '' });

    const onLabeled = jest.fn();
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
    expect(handle.pipelineId).toMatch(/^sid_live_/);
    expect(handle.instanceId).toBe(sid.instanceId);

    // Simulate segmentation committing two spans, then finalize input.
    committed = 2;
    (audiobuffer.getPipelineAudioBufferInfo as jest.Mock).mockResolvedValue({
      bufferId: AUDIO_LIVE,
      kind: 'livePcmBuffer',
      state: 'finished',
      sampleRate: 16000,
      channelCount: 1,
      numSamples: 3600,
      durationMs: 225,
      totalSamplesWritten: 3600,
      ringEvictedSamples: 0,
      hasActiveSpool: false,
    });

    await handle.completed;

    expect(audiobuffer.getLiveAudioBufferSamplesSlice).toHaveBeenCalledTimes(2);
    expect(native.speakerEmbeddingManagerSearch).toHaveBeenCalledWith(
      sid.managerId,
      emb,
      0.55
    );
    expect(segs.appendLiveSegment).toHaveBeenCalledTimes(2);
    expect(segs.appendLiveSegment).toHaveBeenNthCalledWith(
      1,
      SEGS_OUT,
      expect.objectContaining({
        kind: 'speech',
        startSample: 0,
        endSample: 1600,
        payload: { source: 'sid', speakerName: 'alice' },
      })
    );
    expect(segs.appendLiveSegment).toHaveBeenNthCalledWith(
      2,
      SEGS_OUT,
      expect.objectContaining({
        payload: { source: 'sid', speakerName: null },
      })
    );
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
    expect(seg.detachSegmentationEngine).toHaveBeenCalledWith(ENGINE_ID, {
      flushFinal: true,
    });
    expect(segs.finalizeLiveSegmentBuffer).toHaveBeenCalledWith(SEGS_OUT);
    expect(audiobuffer.releasePipelineAudioBuffer).toHaveBeenCalled();
  });

  it('stop() drains tail, finalizes, resolves completed with reason stopped', async () => {
    const spans = [speechSpan(0, 1600)];
    let committed = 0;
    segs.getLiveSegmentBufferSegmentCount.mockImplementation(async () => {
      return committed;
    });
    segs.getLiveSegmentBufferSegments.mockImplementation(
      async (_id: string, start: number, max: number) => {
        return spans.slice(start, start + max);
      }
    );

    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    const handle = await sid.labelLiveSegments(AUDIO_LIVE, SEGS_OUT, {
      segmentation: { policy: defaultPolicy },
    });

    committed = 1;
    await handle.flush();
    expect(segs.appendLiveSegment).toHaveBeenCalledTimes(1);

    await handle.stop();
    const completion = await handle.completed;
    expect(completion.reason).toBe('stopped');
    expect(completion.chunksProcessed).toBe(1);
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
    segs.getLiveSegmentBufferSegmentCount.mockResolvedValue(0);
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

    await handle.stop();
  });

  it('onError is called and completed rejects when labeling throws', async () => {
    const spans = [speechSpan(0, 1600)];
    let committed = 0;
    segs.getLiveSegmentBufferSegmentCount.mockImplementation(async () => {
      return committed;
    });
    segs.getLiveSegmentBufferSegments.mockImplementation(
      async (_id: string, start: number, max: number) => {
        return spans.slice(start, start + max);
      }
    );
    segs.appendLiveSegment.mockRejectedValue(new Error('append failed'));

    const onError = jest.fn();
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    const handle = await sid.labelLiveSegments(AUDIO_LIVE, SEGS_OUT, {
      segmentation: { policy: defaultPolicy },
      onError,
    });

    committed = 1;
    await expect(handle.completed).rejects.toMatchObject({
      code: 'STREAMING_PIPELINE_ERROR',
      message: expect.stringContaining('append failed'),
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'append failed' })
    );
    expect(seg.detachSegmentationEngine).toHaveBeenCalled();
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
  });
});
