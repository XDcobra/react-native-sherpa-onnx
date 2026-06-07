import { buildVadInitBridgeOptions } from '../vadNativeBridge';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(async () => '/models/silero-vad'),
}));

jest.mock('../customConfig', () => ({
  resolveVadCustomConfigPaths: jest.fn(async () => ({
    model: '/models/silero_vad.onnx',
  })),
}));

describe('vadNativeBridge', () => {
  it('buildVadInitBridgeOptions maps auto VAD options to bridge map', async () => {
    const bridge = await buildVadInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/silero-vad' },
      modelType: 'silero_vad',
      sampleRate: 16000,
      runtimeOptions: { sileroVad: { scoreThreshold: 0.5 } },
    });
    expect(bridge).toEqual({
      initMode: 'auto',
      modelDir: '/models/silero-vad',
      modelType: 'silero_vad',
      sampleRate: 16000,
      threshold: 0.5,
    });
  });

  it('buildVadInitBridgeOptions maps custom VAD options to modelPaths', async () => {
    const bridge = await buildVadInitBridgeOptions({
      initMode: 'custom',
      modelType: 'silero_vad',
      customConfig: {
        model: { kind: 'fs', path: '/models/silero_vad.onnx' },
      },
    });
    expect(bridge.initMode).toBe('custom');
    expect(bridge.modelDir).toBeUndefined();
    expect(bridge.modelPaths).toEqual({ model: '/models/silero_vad.onnx' });
    expect(bridge.modelType).toBe('silero_vad');
  });
});
