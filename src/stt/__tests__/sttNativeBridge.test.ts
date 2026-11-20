import {
  buildOnlineSttInitBridgeOptions,
  buildStreamingSttInitBridgeOptions,
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

jest.mock('../streamingCustomConfig', () => ({
  resolveStreamingSttCustomConfigPaths: jest.fn(async () => ({
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
      quantization: 'int8',
      debug: true,
      modelOptions: { whisper: { language: 'en', task: 'transcribe' } },
    });
    expect(bridge).toEqual({
      initMode: 'auto',
      modelDir: '/models/whisper',
      modelType: 'whisper',
      quantization: 'int8',
      debug: true,
      modelOptions: { whisper: { language: 'en', task: 'transcribe' } },
    });
  });

  it('buildSttInitBridgeOptions maps modelingUnit and resolves bpeVocab to a path', async () => {
    const bridge = await buildSttInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/zipformer-en' },
      modelType: 'transducer',
      hotwordsFile: { kind: 'fs', path: '/data/hotwords.txt' },
      modelingUnit: 'bpe',
      bpeVocab: { kind: 'fs', path: '/models/zipformer-en/bpe.vocab' },
    });
    expect(bridge).toMatchObject({
      initMode: 'auto',
      hotwordsFile: '/data/hotwords.txt',
      modelingUnit: 'bpe',
      bpeVocab: '/models/zipformer-en/bpe.vocab',
    });
  });

  it('buildSttInitBridgeOptions omits modelingUnit and bpeVocab when not set', async () => {
    const bridge = await buildSttInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/zipformer-en' },
      modelType: 'transducer',
    });
    expect(bridge).not.toHaveProperty('modelingUnit');
    expect(bridge).not.toHaveProperty('bpeVocab');
  });

  it('buildSttInitBridgeOptions passes modelingUnit and bpeVocab for custom init', async () => {
    const bridge = await buildSttInitBridgeOptions({
      initMode: 'custom',
      modelType: 'transducer',
      customConfig: {
        encoder: { kind: 'fs', path: '/enc.onnx' },
        decoder: { kind: 'fs', path: '/dec.onnx' },
        joiner: { kind: 'fs', path: '/join.onnx' },
        tokens: { kind: 'fs', path: '/tokens.txt' },
      },
      modelingUnit: 'cjkchar+bpe',
      bpeVocab: { kind: 'fs', path: '/bpe.vocab' },
    });
    expect(bridge.initMode).toBe('custom');
    expect(bridge.modelingUnit).toBe('cjkchar+bpe');
    expect(bridge.bpeVocab).toBe('/bpe.vocab');
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

  it('buildStreamingSttInitBridgeOptions maps custom streaming options to modelPaths', async () => {
    const bridge = await buildStreamingSttInitBridgeOptions(
      {
        initMode: 'custom',
        modelType: 'transducer',
        customConfig: {
          encoder: { kind: 'fs', path: '/enc.onnx' },
          decoder: { kind: 'fs', path: '/dec.onnx' },
          joiner: { kind: 'fs', path: '/join.onnx' },
          tokens: { kind: 'fs', path: '/tokens.txt' },
        },
      },
      'transducer'
    );
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

  it('buildStreamingSttInitBridgeOptions maps modelingUnit and resolves bpeVocab for auto init', async () => {
    const bridge = await buildStreamingSttInitBridgeOptions(
      {
        modelSource: { kind: 'fs', path: '/models/stream' },
        modelType: 'transducer',
        decodingMethod: 'modified_beam_search',
        hotwordsFile: '/data/hotwords.txt',
        modelingUnit: 'bpe',
        bpeVocab: { kind: 'fs', path: '/models/stream/bpe.vocab' },
      },
      'transducer'
    );
    expect(bridge).toMatchObject({
      initMode: 'auto',
      modelType: 'transducer',
      decodingMethod: 'modified_beam_search',
      hotwordsFile: '/data/hotwords.txt',
      modelingUnit: 'bpe',
      bpeVocab: '/models/stream/bpe.vocab',
    });
  });

  it('buildStreamingSttInitBridgeOptions passes modelingUnit and bpeVocab for custom init', async () => {
    const bridge = await buildStreamingSttInitBridgeOptions(
      {
        initMode: 'custom',
        modelType: 'transducer',
        customConfig: {
          encoder: { kind: 'fs', path: '/enc.onnx' },
          decoder: { kind: 'fs', path: '/dec.onnx' },
          joiner: { kind: 'fs', path: '/join.onnx' },
          tokens: { kind: 'fs', path: '/tokens.txt' },
        },
        modelingUnit: 'cjkchar+bpe',
        bpeVocab: { kind: 'fs', path: '/bpe.vocab' },
      },
      'transducer'
    );
    expect(bridge.initMode).toBe('custom');
    expect(bridge.modelingUnit).toBe('cjkchar+bpe');
    expect(bridge.bpeVocab).toBe('/bpe.vocab');
  });

  it('buildStreamingSttInitBridgeOptions omits modelingUnit and bpeVocab when not set', async () => {
    const bridge = await buildStreamingSttInitBridgeOptions(
      {
        modelSource: { kind: 'fs', path: '/models/stream' },
        modelType: 'transducer',
      },
      'transducer'
    );
    expect(bridge).not.toHaveProperty('modelingUnit');
    expect(bridge).not.toHaveProperty('bpeVocab');
  });

  it('buildOnlineSttInitBridgeOptions passes modelingUnit', () => {
    const bridge = buildOnlineSttInitBridgeOptions('/models/stream', {
      modelSource: { kind: 'fs', path: '/models/stream' },
      modelType: 'transducer',
      modelingUnit: 'bpe',
    });
    expect(bridge.modelingUnit).toBe('bpe');
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
