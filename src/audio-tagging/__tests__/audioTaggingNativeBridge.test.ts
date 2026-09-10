import { buildAudioTaggingInitBridgeOptions } from '../audioTaggingNativeBridge';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(async () => '/models/ced-mini'),
}));

jest.mock('../customConfig', () => ({
  resolveAudioTaggingCustomConfigPaths: jest.fn(async () => ({
    model: '/models/model.onnx',
    labels: '/models/class_labels_indices.csv',
  })),
}));

describe('audioTaggingNativeBridge', () => {
  it('buildAudioTaggingInitBridgeOptions maps auto options to bridge map', async () => {
    const bridge = await buildAudioTaggingInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/ced-mini' },
      modelType: 'ced',
      numThreads: 2,
      topK: 3,
      debug: false,
    });
    expect(bridge).toEqual({
      initMode: 'auto',
      modelDir: '/models/ced-mini',
      modelType: 'ced',
      numThreads: 2,
      topK: 3,
      debug: false,
    });
  });

  it('buildAudioTaggingInitBridgeOptions maps custom options to modelPaths', async () => {
    const bridge = await buildAudioTaggingInitBridgeOptions({
      initMode: 'custom',
      modelType: 'zipformer',
      customConfig: {
        model: { kind: 'fs', path: '/models/model.onnx' },
        labels: { kind: 'fs', path: '/models/class_labels_indices.csv' },
      },
    });
    expect(bridge.initMode).toBe('custom');
    expect(bridge.modelDir).toBeUndefined();
    expect(bridge.modelPaths).toEqual({
      model: '/models/model.onnx',
      labels: '/models/class_labels_indices.csv',
    });
    expect(bridge.modelType).toBe('zipformer');
  });
});
