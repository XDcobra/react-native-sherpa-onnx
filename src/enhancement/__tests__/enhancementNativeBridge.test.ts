import { buildEnhancementInitBridgeOptions } from '../enhancementNativeBridge';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(async () => '/models/gtcrn'),
}));

jest.mock('../customConfig', () => ({
  resolveEnhancementCustomConfigPaths: jest.fn(async () => ({
    model: '/models/gtcrn.onnx',
  })),
}));

describe('enhancementNativeBridge', () => {
  it('buildEnhancementInitBridgeOptions maps auto options to bridge map', async () => {
    const bridge = await buildEnhancementInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/gtcrn' },
      modelType: 'gtcrn',
      numThreads: 2,
      debug: false,
    });
    expect(bridge).toEqual({
      initMode: 'auto',
      modelDir: '/models/gtcrn',
      modelType: 'gtcrn',
      numThreads: 2,
      debug: false,
    });
  });

  it('buildEnhancementInitBridgeOptions maps custom options to modelPaths', async () => {
    const bridge = await buildEnhancementInitBridgeOptions({
      initMode: 'custom',
      modelType: 'gtcrn',
      customConfig: {
        model: { kind: 'fs', path: '/models/gtcrn.onnx' },
      },
    });
    expect(bridge.initMode).toBe('custom');
    expect(bridge.modelDir).toBeUndefined();
    expect(bridge.modelPaths).toEqual({ model: '/models/gtcrn.onnx' });
    expect(bridge.modelType).toBe('gtcrn');
  });
});
