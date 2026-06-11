jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeSeparation: jest.fn(),
    unloadSeparation: jest.fn(),
    separateOfflineAudioBuffers: jest.fn(),
    getSeparationSampleRate: jest.fn(),
    getSeparationNumStems: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(async () => '/models/uvr'),
}));

jest.mock('../customConfig', () => ({
  resolveSeparationCustomConfigPaths: jest.fn(async () => ({
    model: '/models/uvr.onnx',
  })),
}));

import { buildSeparationInitBridgeOptions } from '../separationNativeBridge';

describe('separationNativeBridge', () => {
  it('buildSeparationInitBridgeOptions maps auto options to bridge map', async () => {
    const bridge = await buildSeparationInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/uvr' },
      modelType: 'uvr',
      numThreads: 2,
      debug: false,
    });
    expect(bridge).toEqual({
      initMode: 'auto',
      modelDir: '/models/uvr',
      modelType: 'uvr',
      numThreads: 2,
      debug: false,
    });
  });

  it('buildSeparationInitBridgeOptions maps custom uvr options to modelPaths', async () => {
    const bridge = await buildSeparationInitBridgeOptions({
      initMode: 'custom',
      modelType: 'uvr',
      customConfig: {
        model: { kind: 'fs', path: '/models/uvr.onnx' },
      },
    });
    expect(bridge.initMode).toBe('custom');
    expect(bridge.modelDir).toBeUndefined();
    expect(bridge.modelPaths).toEqual({ model: '/models/uvr.onnx' });
    expect(bridge.modelType).toBe('uvr');
  });
});
