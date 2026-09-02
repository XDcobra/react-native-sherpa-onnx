jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeSpeakerEmbeddingExtractor: jest.fn(),
    unloadSpeakerEmbeddingExtractor: jest.fn(),
    computeSpeakerEmbeddingOffline: jest.fn(),
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
import {
  acquireSpeakerEmbeddingEngine,
  __resetSpeakerEmbeddingEngineCacheForTests,
} from '../engineCache';

describe('speakerEmbedding engineCache', () => {
  const native = SherpaOnnx as unknown as {
    initializeSpeakerEmbeddingExtractor: jest.Mock;
    unloadSpeakerEmbeddingExtractor: jest.Mock;
    computeSpeakerEmbeddingOffline: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    __resetSpeakerEmbeddingEngineCacheForTests();
    native.initializeSpeakerEmbeddingExtractor.mockResolvedValue({
      success: true,
      dim: 256,
      modelType: 'wespeaker',
    });
    native.unloadSpeakerEmbeddingExtractor.mockResolvedValue(null);
  });

  it('reuses one native init for the same cache key', async () => {
    const a = await acquireSpeakerEmbeddingEngine({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });
    const b = await acquireSpeakerEmbeddingEngine({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    expect(a.instanceId).toBe(b.instanceId);
    expect(native.initializeSpeakerEmbeddingExtractor).toHaveBeenCalledTimes(1);

    await a.destroy();
    expect(native.unloadSpeakerEmbeddingExtractor).not.toHaveBeenCalled();
    await b.destroy();
    expect(native.unloadSpeakerEmbeddingExtractor).toHaveBeenCalledTimes(1);
    expect(native.unloadSpeakerEmbeddingExtractor).toHaveBeenCalledWith(
      a.instanceId
    );
  });
});
