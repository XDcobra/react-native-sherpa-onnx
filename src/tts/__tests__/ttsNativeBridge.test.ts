import { buildTtsInitBridgeOptions } from '../ttsNativeBridge';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(async () => '/models/vits-piper-en'),
}));

jest.mock('../customConfig', () => ({
  resolveTtsCustomConfigPaths: jest.fn(async () => ({
    ttsModel: '/model.onnx',
    tokens: '/tokens.txt',
  })),
}));

describe('ttsNativeBridge', () => {
  it('buildTtsInitBridgeOptions maps auto TTS options to bridge map', async () => {
    const bridge = await buildTtsInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/vits-piper-en' },
      modelType: 'vits',
      debug: true,
      modelOptions: { vits: { noiseScale: 0.667 } },
    });
    expect(bridge).toEqual({
      initMode: 'auto',
      modelDir: '/models/vits-piper-en',
      modelType: 'vits',
      debug: true,
      noiseScale: 0.667,
    });
  });

  it('buildTtsInitBridgeOptions maps custom TTS options to modelPaths', async () => {
    const bridge = await buildTtsInitBridgeOptions({
      initMode: 'custom',
      modelType: 'vits',
      customConfig: {
        ttsModel: { kind: 'fs', path: '/model.onnx' },
        tokens: { kind: 'fs', path: '/tokens.txt' },
      },
    });
    expect(bridge.initMode).toBe('custom');
    expect(bridge.modelDir).toBeUndefined();
    expect(bridge.modelPaths).toEqual({
      ttsModel: '/model.onnx',
      tokens: '/tokens.txt',
    });
    expect(bridge.modelType).toBe('vits');
  });
});
