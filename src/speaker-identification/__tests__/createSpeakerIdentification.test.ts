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
  getPipelineAudioBufferInfo: jest.fn(async () => ({
    sampleRate: 16000,
    channelCount: 1,
  })),
  releasePipelineAudioBuffer: jest.fn(async () => undefined),
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

jest.mock('../../segmentbuffer', () => ({
  getOfflineSegmentBufferSegments: jest.fn(),
  createLiveSegmentBuffer: jest.fn(),
  appendLiveSegment: jest.fn(),
  finalizeLiveSegmentBuffer: jest.fn(),
  populateOfflineSegmentBufferIfEmpty: jest.fn(),
  releasePipelineSegmentBuffer: jest.fn(),
  resolveOfflineSegmentBufferId: jest.fn((value: unknown) => String(value)),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import * as audiobuffer from '../../audiobuffer';
import * as segmentbuffer from '../../segmentbuffer';
import { createSpeakerIdentification } from '../index';

describe('createSpeakerIdentification', () => {
  const native = SherpaOnnx as unknown as {
    initializeSpeakerEmbeddingExtractor: jest.Mock;
    unloadSpeakerEmbeddingExtractor: jest.Mock;
    computeSpeakerEmbeddingOffline: jest.Mock;
    createSpeakerEmbeddingManager: jest.Mock;
    destroySpeakerEmbeddingManager: jest.Mock;
    speakerEmbeddingManagerAdd: jest.Mock;
    speakerEmbeddingManagerRemove: jest.Mock;
    speakerEmbeddingManagerSearch: jest.Mock;
    speakerEmbeddingManagerVerify: jest.Mock;
    speakerEmbeddingManagerContains: jest.Mock;
    speakerEmbeddingManagerNumSpeakers: jest.Mock;
    speakerEmbeddingManagerAllSpeakerNames: jest.Mock;
  };

  const segs = segmentbuffer as unknown as {
    getOfflineSegmentBufferSegments: jest.Mock;
    createLiveSegmentBuffer: jest.Mock;
    appendLiveSegment: jest.Mock;
    finalizeLiveSegmentBuffer: jest.Mock;
    populateOfflineSegmentBufferIfEmpty: jest.Mock;
    releasePipelineSegmentBuffer: jest.Mock;
    resolveOfflineSegmentBufferId: jest.Mock;
  };

  const emb = [1, 2, 3, 4];
  const AUDIO_ID = 'off_123e4567-e89b-12d3-a456-426614174000';
  const SEGS_IN = 'seg_off_123e4567-e89b-12d3-a456-426614174000';
  const SEGS_OUT = 'seg_off_223e4567-e89b-12d3-a456-426614174000';
  const STAGING_LIVE = 'seg_live_323e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    jest.clearAllMocks();
    native.initializeSpeakerEmbeddingExtractor.mockResolvedValue({
      success: true,
      dim: 4,
      modelType: 'wespeaker',
    });
    native.unloadSpeakerEmbeddingExtractor.mockResolvedValue(null);
    native.computeSpeakerEmbeddingOffline.mockResolvedValue({ embedding: emb });
    native.createSpeakerEmbeddingManager.mockResolvedValue({ success: true });
    native.destroySpeakerEmbeddingManager.mockResolvedValue(null);
    native.speakerEmbeddingManagerAdd.mockResolvedValue({ ok: true });
    native.speakerEmbeddingManagerRemove.mockResolvedValue({ ok: true });
    native.speakerEmbeddingManagerSearch.mockResolvedValue({ name: 'alice' });
    native.speakerEmbeddingManagerVerify.mockResolvedValue({ ok: true });
    native.speakerEmbeddingManagerContains.mockResolvedValue({ ok: false });
    native.speakerEmbeddingManagerNumSpeakers.mockResolvedValue(1);
    native.speakerEmbeddingManagerAllSpeakerNames.mockResolvedValue({
      names: ['alice'],
    });

    segs.createLiveSegmentBuffer.mockResolvedValue({
      bufferId: STAGING_LIVE,
      info: { bufferId: STAGING_LIVE },
    });
    segs.appendLiveSegment.mockResolvedValue({
      segmentId: 's1',
      segmentIndex: 0,
    });
    segs.finalizeLiveSegmentBuffer.mockResolvedValue(undefined);
    segs.populateOfflineSegmentBufferIfEmpty.mockResolvedValue(undefined);
    segs.releasePipelineSegmentBuffer.mockResolvedValue(undefined);
  });

  it('enroll → identify → verify → destroy round-trip', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    expect(sid.instanceId).toMatch(/^speakerEmbedding_/);
    expect(sid.managerId).toMatch(/^speakerEmbeddingManager_/);
    expect(sid.dim).toBe(4);
    expect(native.initializeSpeakerEmbeddingExtractor).toHaveBeenCalledWith(
      sid.instanceId,
      expect.objectContaining({
        initMode: 'auto',
        modelDir: '/models/speaker-embedding',
      })
    );
    expect(native.createSpeakerEmbeddingManager).toHaveBeenCalledWith(
      sid.managerId,
      4
    );

    await sid.enroll('alice', ['off_a', 'off_b']);
    expect(native.computeSpeakerEmbeddingOffline).toHaveBeenCalledTimes(2);
    expect(native.speakerEmbeddingManagerAdd).toHaveBeenCalledWith(
      sid.managerId,
      'alice',
      [...emb, ...emb],
      2
    );

    const identified = await sid.identify('off_query', { threshold: 0.6 });
    expect(identified).toEqual({ name: 'alice' });
    expect(native.speakerEmbeddingManagerSearch).toHaveBeenCalledWith(
      sid.managerId,
      emb,
      0.6
    );

    await expect(sid.verify('alice', 'off_query')).resolves.toBe(true);
    expect(native.speakerEmbeddingManagerVerify).toHaveBeenCalledWith(
      sid.managerId,
      'alice',
      emb,
      0.5
    );

    await expect(sid.listSpeakers()).resolves.toEqual(['alice']);
    native.speakerEmbeddingManagerContains.mockResolvedValue({ ok: true });
    await expect(sid.contains('alice')).resolves.toBe(true);
    await expect(sid.numSpeakers()).resolves.toBe(1);

    await sid.destroy();
    expect(native.destroySpeakerEmbeddingManager).toHaveBeenCalledWith(
      sid.managerId
    );
    expect(native.unloadSpeakerEmbeddingExtractor).toHaveBeenCalledWith(
      sid.instanceId
    );
  });

  it('guards methods after destroy', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await sid.destroy();
    await expect(sid.listSpeakers()).rejects.toThrow(/has been destroyed/);
  });

  it('returns null name when search misses', async () => {
    native.speakerEmbeddingManagerSearch.mockResolvedValue({ name: '' });
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await expect(sid.identify('off_query')).resolves.toEqual({ name: null });
  });

  it('enroll rejects duplicate name before extracting embeddings', async () => {
    native.speakerEmbeddingManagerContains.mockResolvedValue({ ok: true });
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await expect(sid.enroll('alice', 'off_a')).rejects.toThrow(
      /already enrolled/
    );
    expect(native.computeSpeakerEmbeddingOffline).not.toHaveBeenCalled();
    expect(native.speakerEmbeddingManagerAdd).not.toHaveBeenCalled();
  });

  it('enrollOfflineSegments rejects duplicate name before extracting spans', async () => {
    native.speakerEmbeddingManagerContains.mockResolvedValue({ ok: true });
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
      },
    ]);
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await expect(
      sid.enrollOfflineSegments('alice', AUDIO_ID, SEGS_IN)
    ).rejects.toThrow(/already enrolled/);
    expect(native.computeSpeakerEmbeddingOffline).not.toHaveBeenCalled();
    expect(native.speakerEmbeddingManagerAdd).not.toHaveBeenCalled();
  });

  it('enrollOfflineSegments extracts each speech span then manager.add', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'b',
        kind: 'alignment',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 1600,
        endSample: 3200,
        sampleRate: 16000,
        durationMs: 100,
        payload: {
          text: 'x',
          timingMode: 'proportional',
          granularity: 'word',
        },
      },
      {
        id: 'c',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 3200,
        endSample: 4800,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'empty',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 5000,
        endSample: 5000,
        sampleRate: 16000,
        durationMs: 0,
      },
    ]);

    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await sid.enrollOfflineSegments('alice', AUDIO_ID, SEGS_IN);

    expect(segs.getOfflineSegmentBufferSegments).toHaveBeenCalledWith(SEGS_IN);
    expect(native.computeSpeakerEmbeddingOffline).toHaveBeenCalledTimes(2);
    expect(native.computeSpeakerEmbeddingOffline).toHaveBeenNthCalledWith(
      1,
      sid.instanceId,
      AUDIO_ID,
      0,
      1600
    );
    expect(native.computeSpeakerEmbeddingOffline).toHaveBeenNthCalledWith(
      2,
      sid.instanceId,
      AUDIO_ID,
      3200,
      4800
    );
    expect(
      audiobuffer.getOfflineAudioBufferSamplesSlice
    ).not.toHaveBeenCalled();
    expect(
      audiobuffer.createOfflineAudioBufferFromSamples
    ).not.toHaveBeenCalled();
    expect(native.speakerEmbeddingManagerAdd).toHaveBeenCalledWith(
      sid.managerId,
      'alice',
      [...emb, ...emb],
      2
    );
  });

  it('enrollOfflineSegments rejects when no speech spans', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'alignment',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 100,
        sampleRate: 16000,
        durationMs: 10,
        payload: {
          text: 'x',
          timingMode: 'proportional',
          granularity: 'word',
        },
      },
    ]);

    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.enrollOfflineSegments('alice', AUDIO_ID, SEGS_IN)
    ).rejects.toThrow(/at least one non-empty speech span/);
  });

  it('enrollOfflineSegments name list enrolls one speaker per span', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'c',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 3200,
        endSample: 4800,
        sampleRate: 16000,
        durationMs: 100,
      },
    ]);

    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await sid.enrollOfflineSegments(['alice', 'bob'], AUDIO_ID, SEGS_IN);

    expect(native.computeSpeakerEmbeddingOffline).toHaveBeenCalledTimes(2);
    expect(native.computeSpeakerEmbeddingOffline).toHaveBeenNthCalledWith(
      1,
      sid.instanceId,
      AUDIO_ID,
      0,
      1600
    );
    expect(native.computeSpeakerEmbeddingOffline).toHaveBeenNthCalledWith(
      2,
      sid.instanceId,
      AUDIO_ID,
      3200,
      4800
    );
    expect(native.speakerEmbeddingManagerAdd).toHaveBeenCalledTimes(2);
    expect(native.speakerEmbeddingManagerAdd).toHaveBeenNthCalledWith(
      1,
      sid.managerId,
      'alice',
      emb,
      1
    );
    expect(native.speakerEmbeddingManagerAdd).toHaveBeenNthCalledWith(
      2,
      sid.managerId,
      'bob',
      emb,
      1
    );
  });

  it('enrollOfflineSegments name list groups duplicate names into one add', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'b',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 2000,
        endSample: 3600,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'c',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 4000,
        endSample: 5600,
        sampleRate: 16000,
        durationMs: 100,
      },
    ]);

    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await sid.enrollOfflineSegments(
      ['alice', 'bob', 'alice'],
      AUDIO_ID,
      SEGS_IN
    );

    expect(native.speakerEmbeddingManagerAdd).toHaveBeenCalledTimes(2);
    expect(native.speakerEmbeddingManagerAdd).toHaveBeenCalledWith(
      sid.managerId,
      'alice',
      [...emb, ...emb],
      2
    );
    expect(native.speakerEmbeddingManagerAdd).toHaveBeenCalledWith(
      sid.managerId,
      'bob',
      emb,
      1
    );
  });

  it('enrollOfflineSegments rejects name list length mismatch before extract', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'c',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 3200,
        endSample: 4800,
        sampleRate: 16000,
        durationMs: 100,
      },
    ]);

    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.enrollOfflineSegments(['alice'], AUDIO_ID, SEGS_IN)
    ).rejects.toThrow(
      /name list length \(1\) must match speech span count \(2\)/
    );
    expect(native.computeSpeakerEmbeddingOffline).not.toHaveBeenCalled();
    expect(native.speakerEmbeddingManagerAdd).not.toHaveBeenCalled();
  });

  it('enrollOfflineSegments rejects empty name in list before extract', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
    ]);

    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.enrollOfflineSegments(['  '], AUDIO_ID, SEGS_IN)
    ).rejects.toThrow(/names\[0\] must be a non-empty string/);
    expect(native.computeSpeakerEmbeddingOffline).not.toHaveBeenCalled();
  });

  it('enrollOfflineSegments rejects already-enrolled name in list before extract', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'c',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 3200,
        endSample: 4800,
        sampleRate: 16000,
        durationMs: 100,
      },
    ]);
    native.speakerEmbeddingManagerContains.mockImplementation(
      async (_id: string, name: string) => ({ ok: name === 'bob' })
    );

    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.enrollOfflineSegments(['alice', 'bob'], AUDIO_ID, SEGS_IN)
    ).rejects.toThrow(/Speaker 'bob' is already enrolled/);
    expect(native.computeSpeakerEmbeddingOffline).not.toHaveBeenCalled();
    expect(native.speakerEmbeddingManagerAdd).not.toHaveBeenCalled();
  });

  it('labelOfflineSegments stages sid payloads and populates out', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
        confidence: 0.9,
      },
      {
        id: 'b',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 2000,
        endSample: 3600,
        sampleRate: 16000,
        durationMs: 100,
      },
    ]);
    native.speakerEmbeddingManagerSearch
      .mockResolvedValueOnce({ name: 'alice' })
      .mockResolvedValueOnce({ name: '' });

    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    const result = await sid.labelOfflineSegments(AUDIO_ID, SEGS_IN, SEGS_OUT, {
      threshold: 0.55,
    });

    expect(result).toEqual({ labeledCount: 1, unknownCount: 1 });
    expect(native.computeSpeakerEmbeddingOffline).toHaveBeenNthCalledWith(
      1,
      sid.instanceId,
      AUDIO_ID,
      0,
      1600
    );
    expect(native.computeSpeakerEmbeddingOffline).toHaveBeenNthCalledWith(
      2,
      sid.instanceId,
      AUDIO_ID,
      2000,
      3600
    );
    expect(
      audiobuffer.getOfflineAudioBufferSamplesSlice
    ).not.toHaveBeenCalled();
    expect(segs.createLiveSegmentBuffer).toHaveBeenCalledWith({
      sourceAudioBufferId: AUDIO_ID,
      spooling: { mode: 'on' },
    });
    expect(segs.appendLiveSegment).toHaveBeenCalledTimes(2);
    expect(segs.appendLiveSegment).toHaveBeenNthCalledWith(
      1,
      STAGING_LIVE,
      expect.objectContaining({
        kind: 'speech',
        startSample: 0,
        endSample: 1600,
        payload: { source: 'sid', speakerName: 'alice' },
      })
    );
    expect(segs.appendLiveSegment).toHaveBeenNthCalledWith(
      2,
      STAGING_LIVE,
      expect.objectContaining({
        payload: { source: 'sid', speakerName: null },
      })
    );
    expect(native.speakerEmbeddingManagerSearch).toHaveBeenCalledWith(
      sid.managerId,
      emb,
      0.55
    );
    expect(segs.finalizeLiveSegmentBuffer).toHaveBeenCalledWith(STAGING_LIVE);
    expect(segs.populateOfflineSegmentBufferIfEmpty).toHaveBeenCalledWith(
      SEGS_OUT,
      STAGING_LIVE
    );
    expect(segs.releasePipelineSegmentBuffer).toHaveBeenCalledWith(
      STAGING_LIVE
    );
  });

  it('labelOfflineSegments releases staging on failure', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
    ]);
    segs.appendLiveSegment.mockRejectedValue(new Error('append failed'));

    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.labelOfflineSegments(AUDIO_ID, SEGS_IN, SEGS_OUT)
    ).rejects.toThrow(/append failed/);
    expect(segs.releasePipelineSegmentBuffer).toHaveBeenCalledWith(
      STAGING_LIVE
    );
  });

  it('labelOfflineSegments emits onProgress before each span extract', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'b',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 2000,
        endSample: 3600,
        sampleRate: 16000,
        durationMs: 200,
      },
    ]);

    const onProgress = jest.fn();
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await sid.labelOfflineSegments(AUDIO_ID, SEGS_IN, SEGS_OUT, {
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        currentSegment: 0,
        totalSegments: 2,
        fraction: 0,
        currentSegmentDurationMs: 100,
      })
    );
    expect(onProgress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        currentSegment: 1,
        totalSegments: 2,
        fraction: 0.5,
        currentSegmentDurationMs: 200,
      })
    );
    const firstElapsed = onProgress.mock.calls[0]![0].elapsedMs as number;
    const secondElapsed = onProgress.mock.calls[1]![0].elapsedMs as number;
    expect(secondElapsed).toBeGreaterThanOrEqual(firstElapsed);

    const firstProgressOrder = onProgress.mock.invocationCallOrder[0]!;
    const firstComputeOrder =
      native.computeSpeakerEmbeddingOffline.mock.invocationCallOrder[0]!;
    expect(firstProgressOrder).toBeLessThan(firstComputeOrder);
    expect(
      audiobuffer.getOfflineAudioBufferSamplesSlice
    ).not.toHaveBeenCalled();
  });

  it('labelOfflineSegments rejects non-function onProgress', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([]);
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await expect(
      sid.labelOfflineSegments(AUDIO_ID, SEGS_IN, SEGS_OUT, {
        onProgress: 123 as any,
      })
    ).rejects.toThrow(/onProgress must be a function/);
  });

  it('labelOfflineSegments aborts when onProgress throws and releases staging', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
    ]);
    const onProgress = jest.fn(() => {
      throw new Error('progress failed');
    });
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.labelOfflineSegments(AUDIO_ID, SEGS_IN, SEGS_OUT, { onProgress })
    ).rejects.toThrow(/progress failed/);
    expect(native.computeSpeakerEmbeddingOffline).not.toHaveBeenCalled();
    expect(segs.releasePipelineSegmentBuffer).toHaveBeenCalledWith(
      STAGING_LIVE
    );
  });

  it('labelOfflineSegments with zero speech spans skips onProgress', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'alignment',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 100,
        sampleRate: 16000,
        durationMs: 10,
        payload: {
          text: 'x',
          timingMode: 'proportional',
          granularity: 'word',
        },
      },
    ]);
    const onProgress = jest.fn();
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.labelOfflineSegments(AUDIO_ID, SEGS_IN, SEGS_OUT, { onProgress })
    ).resolves.toEqual({ labeledCount: 0, unknownCount: 0 });
    expect(onProgress).not.toHaveBeenCalled();
    expect(segs.createLiveSegmentBuffer).not.toHaveBeenCalled();
  });

  it('enrollOfflineSegments emits onProgress per speech span', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'c',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 3200,
        endSample: 4800,
        sampleRate: 16000,
        durationMs: 100,
      },
    ]);
    const onProgress = jest.fn();
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await sid.enrollOfflineSegments('alice', AUDIO_ID, SEGS_IN, { onProgress });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        currentSegment: 0,
        totalSegments: 2,
        fraction: 0,
      })
    );
    expect(onProgress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        currentSegment: 1,
        totalSegments: 2,
        fraction: 0.5,
      })
    );
  });

  it('verifyOfflineSegments checks each speech span against one name', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'b',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 2000,
        endSample: 3600,
        sampleRate: 16000,
        durationMs: 200,
      },
    ]);
    native.speakerEmbeddingManagerVerify
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });

    const onProgress = jest.fn();
    const onVerified = jest.fn();
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.verifyOfflineSegments('alice', AUDIO_ID, SEGS_IN, {
        threshold: 0.55,
        onProgress,
        onVerified,
      })
    ).resolves.toEqual({
      matchCount: 1,
      mismatchCount: 1,
      matches: [true, false],
    });

    expect(native.computeSpeakerEmbeddingOffline).toHaveBeenCalledTimes(2);
    expect(native.speakerEmbeddingManagerVerify).toHaveBeenNthCalledWith(
      1,
      sid.managerId,
      'alice',
      emb,
      0.55
    );
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onVerified).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        segmentIndex: 0,
        totalSegments: 2,
        expectedName: 'alice',
        matched: true,
        durationMs: 100,
      })
    );
    expect(onVerified).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        segmentIndex: 1,
        expectedName: 'alice',
        matched: false,
        durationMs: 200,
      })
    );
  });

  it('verifyOfflineSegments name list verifies each span against its name', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'b',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 2000,
        endSample: 3600,
        sampleRate: 16000,
        durationMs: 200,
      },
    ]);
    native.speakerEmbeddingManagerVerify
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });

    const onVerified = jest.fn();
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.verifyOfflineSegments(['alice', 'bob'], AUDIO_ID, SEGS_IN, {
        onVerified,
      })
    ).resolves.toEqual({
      matchCount: 1,
      mismatchCount: 1,
      matches: [true, false],
    });

    expect(native.speakerEmbeddingManagerVerify).toHaveBeenNthCalledWith(
      1,
      sid.managerId,
      'alice',
      emb,
      0.5
    );
    expect(native.speakerEmbeddingManagerVerify).toHaveBeenNthCalledWith(
      2,
      sid.managerId,
      'bob',
      emb,
      0.5
    );
    expect(onVerified).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedName: 'alice', matched: true })
    );
    expect(onVerified).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedName: 'bob', matched: false })
    );
  });

  it('verifyOfflineSegments rejects name list length mismatch before extract', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'b',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 2000,
        endSample: 3600,
        sampleRate: 16000,
        durationMs: 100,
      },
    ]);
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await expect(
      sid.verifyOfflineSegments(['alice'], AUDIO_ID, SEGS_IN)
    ).rejects.toThrow(
      /name list length \(1\) must match speech span count \(2\)/
    );
    expect(native.computeSpeakerEmbeddingOffline).not.toHaveBeenCalled();
  });

  it('verifyOfflineSegments rejects when no speech spans', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'sil',
        kind: 'silence',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
      },
    ]);
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await expect(
      sid.verifyOfflineSegments('alice', AUDIO_ID, SEGS_IN)
    ).rejects.toThrow(/at least one non-empty speech span/);
    expect(native.computeSpeakerEmbeddingOffline).not.toHaveBeenCalled();
  });

  it('verifyOfflineSegments rejects non-function onVerified', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await expect(
      sid.verifyOfflineSegments('alice', AUDIO_ID, SEGS_IN, {
        onVerified: 123 as any,
      })
    ).rejects.toThrow(/onVerified must be a function/);
  });

  it('labelOfflineSegments emits onLabeled after each append with speakerName', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
      {
        id: 'b',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 2000,
        endSample: 3600,
        sampleRate: 16000,
        durationMs: 200,
      },
    ]);
    native.speakerEmbeddingManagerSearch
      .mockResolvedValueOnce({ name: 'alice' })
      .mockResolvedValueOnce({ name: '' });

    const onProgress = jest.fn();
    const onLabeled = jest.fn();
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await sid.labelOfflineSegments(AUDIO_ID, SEGS_IN, SEGS_OUT, {
      onProgress,
      onLabeled,
    });

    expect(onLabeled).toHaveBeenCalledTimes(2);
    expect(onLabeled).toHaveBeenNthCalledWith(1, {
      segmentIndex: 0,
      totalSegments: 2,
      startSample: 0,
      endSample: 1600,
      sampleRate: 16000,
      durationMs: 100,
      speakerName: 'alice',
    });
    expect(onLabeled).toHaveBeenNthCalledWith(2, {
      segmentIndex: 1,
      totalSegments: 2,
      startSample: 2000,
      endSample: 3600,
      sampleRate: 16000,
      durationMs: 200,
      speakerName: null,
    });

    const progress0 = onProgress.mock.invocationCallOrder[0]!;
    const append0 = segs.appendLiveSegment.mock.invocationCallOrder[0]!;
    const labeled0 = onLabeled.mock.invocationCallOrder[0]!;
    expect(progress0).toBeLessThan(append0);
    expect(append0).toBeLessThan(labeled0);
  });

  it('labelOfflineSegments rejects non-function onLabeled', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await expect(
      sid.labelOfflineSegments(AUDIO_ID, SEGS_IN, SEGS_OUT, {
        onLabeled: 123 as any,
      })
    ).rejects.toThrow(/onLabeled must be a function/);
  });

  it('labelOfflineSegments aborts when onLabeled throws and releases staging', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        durationMs: 100,
      },
    ]);
    const onLabeled = jest.fn(() => {
      throw new Error('labeled failed');
    });
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.labelOfflineSegments(AUDIO_ID, SEGS_IN, SEGS_OUT, { onLabeled })
    ).rejects.toThrow(/labeled failed/);
    expect(segs.appendLiveSegment).toHaveBeenCalledTimes(1);
    expect(segs.finalizeLiveSegmentBuffer).not.toHaveBeenCalled();
    expect(segs.releasePipelineSegmentBuffer).toHaveBeenCalledWith(
      STAGING_LIVE
    );
  });

  it('labelOfflineSegments with zero speech spans skips onLabeled', async () => {
    segs.getOfflineSegmentBufferSegments.mockResolvedValue([]);
    const onLabeled = jest.fn();
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await expect(
      sid.labelOfflineSegments(AUDIO_ID, SEGS_IN, SEGS_OUT, { onLabeled })
    ).resolves.toEqual({ labeledCount: 0, unknownCount: 0 });
    expect(onLabeled).not.toHaveBeenCalled();
  });

  it('exportEnrollments / importEnrollments round-trip restores speakers', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    await sid.enroll('alice', ['off_a', 'off_b']);
    const bundle = await sid.exportEnrollments();
    expect(bundle).toEqual({
      version: 1,
      dim: 4,
      modelKey: expect.any(String),
      speakers: [
        {
          name: 'alice',
          embeddings: [emb, emb],
        },
      ],
    });

    await sid.destroy();

    const sid2 = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    native.speakerEmbeddingManagerAdd.mockClear();

    await expect(sid2.importEnrollments(bundle)).resolves.toEqual({
      imported: 1,
      skipped: 0,
    });
    expect(native.speakerEmbeddingManagerAdd).toHaveBeenCalledWith(
      sid2.managerId,
      'alice',
      [...emb, ...emb],
      2
    );

    const reexported = await sid2.exportEnrollments();
    expect(reexported.speakers).toEqual(bundle.speakers);
    expect(reexported.modelKey).toBe(bundle.modelKey);
  });

  it('importEnrollments rejects name collision unless replaceExisting', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await sid.enroll('alice', 'off_a');
    const bundle = await sid.exportEnrollments();

    native.speakerEmbeddingManagerAdd.mockResolvedValueOnce({ ok: false });
    await expect(sid.importEnrollments(bundle)).rejects.toThrow(
      /name may already exist/
    );

    native.speakerEmbeddingManagerAdd.mockResolvedValue({ ok: true });
    native.speakerEmbeddingManagerRemove.mockResolvedValue({ ok: true });
    await expect(
      sid.importEnrollments(bundle, { replaceExisting: true })
    ).resolves.toEqual({ imported: 1, skipped: 0 });
    expect(native.speakerEmbeddingManagerRemove).toHaveBeenCalledWith(
      sid.managerId,
      'alice'
    );
    expect(native.speakerEmbeddingManagerAdd).toHaveBeenCalled();
  });

  it('importEnrollments rejects dim mismatch', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await expect(
      sid.importEnrollments({
        version: 1,
        dim: 8,
        speakers: [{ name: 'alice', embeddings: [[1, 2, 3, 4, 5, 6, 7, 8]] }],
      })
    ).rejects.toThrow(/SID_ENROLLMENT_DIM_MISMATCH/);
  });

  it('importEnrollments rejects modelKey mismatch', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await expect(
      sid.importEnrollments({
        version: 1,
        dim: 4,
        modelKey: JSON.stringify({
          modelKey: '/other-model',
          provider: 'cpu',
          numThreads: 1,
        }),
        speakers: [{ name: 'alice', embeddings: [emb] }],
      })
    ).rejects.toThrow(/SID_ENROLLMENT_MODEL_MISMATCH/);
  });

  it('removeSpeaker drops the enrollment mirror entry', async () => {
    const sid = await createSpeakerIdentification({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    await sid.enroll('alice', 'off_a');
    await expect(sid.exportEnrollments()).resolves.toEqual(
      expect.objectContaining({
        speakers: [expect.objectContaining({ name: 'alice' })],
      })
    );

    await expect(sid.removeSpeaker('alice')).resolves.toBe(true);
    await expect(sid.exportEnrollments()).resolves.toEqual(
      expect.objectContaining({ speakers: [] })
    );
  });
});
