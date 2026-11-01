import {
  buildTtsInitBridgeOptions,
  toNativeSynthesisOptions,
} from '../ttsNativeBridge';

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
      quantization: 'fp16',
      modelOptions: { vits: { noiseScale: 0.667 } },
    });
    expect(bridge).toEqual({
      initMode: 'auto',
      modelDir: '/models/vits-piper-en',
      modelType: 'vits',
      debug: true,
      noiseScale: 0.667,
      quantization: 'fp16',
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

  it('buildTtsInitBridgeOptions maps kitten customConfig without dataDir', async () => {
    const { resolveTtsCustomConfigPaths } = jest.requireMock('../customConfig');
    resolveTtsCustomConfigPaths.mockResolvedValueOnce({
      ttsModel: '/kitten.onnx',
      tokens: '/tokens.txt',
      voices: '/voices.bin',
      lexicon: '/lexicon-en-us.txt',
    });
    const bridge = await buildTtsInitBridgeOptions({
      initMode: 'custom',
      modelType: 'kitten',
      customConfig: {
        ttsModel: { kind: 'fs', path: '/kitten.onnx' },
        tokens: { kind: 'fs', path: '/tokens.txt' },
        voices: { kind: 'fs', path: '/voices.bin' },
        lexicon: { kind: 'fs', path: '/lexicon-en-us.txt' },
      },
    });
    expect(bridge.modelPaths).toEqual({
      ttsModel: '/kitten.onnx',
      tokens: '/tokens.txt',
      voices: '/voices.bin',
      lexicon: '/lexicon-en-us.txt',
    });
    expect(bridge.modelPaths).not.toHaveProperty('dataDir');
  });

  it('toNativeSynthesisOptions forwards phonemeCodepoints and tokens', () => {
    expect(
      toNativeSynthesisOptions({
        sid: 0,
        phonemeCodepoints: [[116, 601, 100]],
      })
    ).toEqual({
      sid: 0,
      phonemeCodepoints: [[116, 601, 100]],
    });
    expect(
      toNativeSynthesisOptions({
        tokens: [['ð', 'ə']],
      })
    ).toEqual({
      tokens: [['ð', 'ə']],
    });
  });
});
