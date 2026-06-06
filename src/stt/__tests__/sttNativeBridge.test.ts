import {
  buildOnlineSttInitBridgeOptions,
  buildSttInitBridgeOptions,
} from '../sttNativeBridge';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(async () => '/models/whisper'),
  resolveFileSourceForModelFile: jest.fn(
    async (source: { path: string }) => source.path
  ),
  resolveModelFileSources: jest.fn(
    async (config: Record<string, { path: string }>) =>
      Object.fromEntries(Object.entries(config).map(([k, v]) => [k, v.path]))
  ),
}));

jest.mock('../customConfig', () => ({
  resolveSttCustomConfigPaths: jest.fn(async () => ({
    encoder: '/enc.onnx',
    decoder: '/dec.onnx',
    joiner: '/join.onnx',
    tokens: '/tokens.txt',
  })),
}));

describe('sttNativeBridge', () => {
  it('buildSttInitBridgeOptions maps auto STT options to bridge map', async () => {
    const bridge = await buildSttInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/whisper' },
      modelType: 'whisper',
      preferInt8: true,
      debug: true,
      modelOptions: { whisper: { language: 'en', task: 'transcribe' } },
    });
    expect(bridge).toEqual({
      initMode: 'auto',
      modelDir: '/models/whisper',
      modelType: 'whisper',
      preferInt8: true,
      debug: true,
      modelOptions: { whisper: { language: 'en', task: 'transcribe' } },
    });
  });

  it('buildSttInitBridgeOptions maps custom STT options to modelPaths', async () => {
    const bridge = await buildSttInitBridgeOptions({
      initMode: 'custom',
      modelType: 'transducer',
      customConfig: {
        encoder: { kind: 'fs', path: '/enc.onnx' },
        decoder: { kind: 'fs', path: '/dec.onnx' },
        joiner: { kind: 'fs', path: '/join.onnx' },
        tokens: { kind: 'fs', path: '/tokens.txt' },
      },
    });
    expect(bridge.initMode).toBe('custom');
    expect(bridge.modelDir).toBeUndefined();
    expect(bridge.modelPaths).toEqual({
      encoder: '/enc.onnx',
      decoder: '/dec.onnx',
      joiner: '/join.onnx',
      tokens: '/tokens.txt',
    });
    expect(bridge.modelType).toBe('transducer');
  });

  it('buildOnlineSttInitBridgeOptions flattens endpoint rules', () => {
    const bridge = buildOnlineSttInitBridgeOptions('/models/stream', {
      modelSource: { kind: 'fs', path: '/models/stream' },
      modelType: 'transducer',
      enableEndpoint: true,
      endpointConfig: {
        rule1: {
          mustContainNonSilence: false,
          minTrailingSilence: 2.4,
          minUtteranceLength: 0,
        },
      },
    });
    expect(bridge.modelDir).toBe('/models/stream');
    expect(bridge.modelType).toBe('transducer');
    expect(bridge.enableEndpoint).toBe(true);
    expect(bridge.rule1MinTrailingSilence).toBe(2.4);
    expect(bridge.rule1MustContainNonSilence).toBe(false);
  });
});
