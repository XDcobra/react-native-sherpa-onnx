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
import { __resetSpeakerEmbeddingEngineCacheForTests } from '../../speaker-embedding/engineCache';
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
    native.speakerEmbeddingManagerAdd.mockResolvedValue({ ok: true });
    native.speakerEmbeddingManagerRemove.mockResolvedValue({ ok: true });
    native.speakerEmbeddingManagerSearch.mockResolvedValue({ name: 'alice' });
    native.speakerEmbeddingManagerVerify.mockResolvedValue({ ok: true });
    native.speakerEmbeddingManagerContains.mockResolvedValue({ ok: true });
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
    expect(audiobuffer.getOfflineAudioBufferSamplesSlice).toHaveBeenCalledTimes(
      2
    );
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
});
