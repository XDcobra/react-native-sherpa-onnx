import {
  buildOfflinePunctuationInitBridgeOptions,
  buildStreamingPunctuationInitBridgeOptions,
} from '../punctuationNativeBridge';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(async () => '/models/punctuation'),
}));

jest.mock('../customConfig', () => ({
  resolveOfflinePunctuationCustomConfigPaths: jest.fn(async () => ({
    ct_transformer: '/models/ct.onnx',
  })),
  resolveStreamingPunctuationCustomConfigPaths: jest.fn(async () => ({
    cnn_bilstm: '/models/cnn.onnx',
    bpe_vocab: '/models/bpe.vocab',
  })),
}));

describe('punctuationNativeBridge', () => {
  it('buildOfflinePunctuationInitBridgeOptions maps auto options to bridge map', async () => {
    const bridge = await buildOfflinePunctuationInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/punctuation-offline' },
      modelType: 'ct_transformer',
      numThreads: 2,
      debug: false,
    });
    expect(bridge).toEqual({
      initMode: 'auto',
      modelDir: '/models/punctuation',
      modelType: 'ct_transformer',
      numThreads: 2,
      debug: false,
    });
  });

  it('buildOfflinePunctuationInitBridgeOptions maps custom options to modelPaths', async () => {
    const bridge = await buildOfflinePunctuationInitBridgeOptions({
      initMode: 'custom',
      modelType: 'ct_transformer',
      customConfig: {
        ct_transformer: { kind: 'fs', path: '/models/ct.onnx' },
      },
    });
    expect(bridge.initMode).toBe('custom');
    expect(bridge.modelDir).toBeUndefined();
    expect(bridge.modelPaths).toEqual({ ct_transformer: '/models/ct.onnx' });
    expect(bridge.modelType).toBe('ct_transformer');
  });

  it('buildStreamingPunctuationInitBridgeOptions maps auto options to bridge map', async () => {
    const bridge = await buildStreamingPunctuationInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/punctuation-online' },
      modelType: 'cnn_bilstm',
      provider: 'cpu',
    });
    expect(bridge).toEqual({
      initMode: 'auto',
      modelDir: '/models/punctuation',
      modelType: 'cnn_bilstm',
      provider: 'cpu',
    });
  });

  it('buildStreamingPunctuationInitBridgeOptions maps custom options to modelPaths', async () => {
    const bridge = await buildStreamingPunctuationInitBridgeOptions({
      initMode: 'custom',
      modelType: 'cnn_bilstm',
      customConfig: {
        cnn_bilstm: { kind: 'fs', path: '/models/cnn.onnx' },
        bpe_vocab: { kind: 'fs', path: '/models/bpe.vocab' },
      },
    });
    expect(bridge.initMode).toBe('custom');
    expect(bridge.modelPaths).toEqual({
      cnn_bilstm: '/models/cnn.onnx',
      bpe_vocab: '/models/bpe.vocab',
    });
  });
});
