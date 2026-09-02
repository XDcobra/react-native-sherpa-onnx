jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(
    async () => '/models/speaker-embedding'
  ),
}));

jest.mock('../customConfig', () => ({
  resolveSpeakerEmbeddingCustomConfigPaths: jest.fn(async () => ({
    model: '/models/custom/model.onnx',
  })),
}));

import { resolveFileSourceForModelInit } from '../../detect/resolveModelInput';
import { resolveSpeakerEmbeddingCustomConfigPaths } from '../customConfig';
import {
  buildSpeakerEmbeddingInitBridgeOptions,
  speakerEmbeddingEngineCacheKeyFromBridgeOptions,
} from '../speakerEmbeddingNativeBridge';

describe('speakerEmbeddingNativeBridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps auto init options', async () => {
    const bridge = await buildSpeakerEmbeddingInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
      modelType: 'wespeaker',
      numThreads: 2,
      provider: 'cpu',
    });

    expect(resolveFileSourceForModelInit).toHaveBeenCalled();
    expect(bridge).toEqual({
      initMode: 'auto',
      modelDir: '/models/speaker-embedding',
      modelType: 'wespeaker',
      numThreads: 2,
      provider: 'cpu',
    });
  });

  it('maps custom init options', async () => {
    const bridge = await buildSpeakerEmbeddingInitBridgeOptions({
      initMode: 'custom',
      modelType: 'nemo',
      customConfig: {
        model: { kind: 'fs', path: '/models/custom/model.onnx' },
      },
    });

    expect(resolveSpeakerEmbeddingCustomConfigPaths).toHaveBeenCalledWith(
      'nemo',
      expect.objectContaining({
        model: { kind: 'fs', path: '/models/custom/model.onnx' },
      })
    );
    expect(bridge).toEqual({
      initMode: 'custom',
      modelType: 'nemo',
      modelPaths: { model: '/models/custom/model.onnx' },
    });
  });

  it('builds a stable engine cache key', () => {
    const key = speakerEmbeddingEngineCacheKeyFromBridgeOptions({
      initMode: 'auto',
      modelDir: '/models/a',
      modelType: 'wespeaker',
      provider: 'cpu',
      numThreads: 1,
    });
    expect(key).toBe(
      JSON.stringify({ modelKey: '/models/a', provider: 'cpu', numThreads: 1 })
    );
  });
});
