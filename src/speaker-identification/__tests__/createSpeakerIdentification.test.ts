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
  createOfflineAudioBufferFromSamples: jest.fn(),
  getOfflineAudioBufferSamplesSlice: jest.fn(),
  getPipelineAudioBufferInfo: jest.fn(),
  releasePipelineAudioBuffer: jest.fn(),
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
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

  const emb = [1, 2, 3, 4];

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
});
