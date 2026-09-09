jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeKeywordSpotting: jest.fn(),
    unloadKeywordSpotting: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(),
}));

jest.mock('../detectKwsModel', () => ({
  detectKwsModel: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { resolveFileSourceForModelInit } from '../../detect/resolveModelInput';
import {
  createKeywordSpotting,
  createStreamingKWS,
} from '../createKeywordSpotting';
import { detectKwsModel } from '../detectKwsModel';

describe('createKeywordSpotting', () => {
  const native = SherpaOnnx as unknown as {
    initializeKeywordSpotting: jest.Mock;
    unloadKeywordSpotting: jest.Mock;
  };
  const resolveModel = resolveFileSourceForModelInit as jest.Mock;
  const detect = detectKwsModel as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    resolveModel.mockResolvedValue('/models/kws');
    detect.mockResolvedValue({
      success: true,
      isStreaming: true,
      detectedModels: [],
      modelType: 'transducer',
      paths: {
        encoder: '/models/kws/encoder.onnx',
        decoder: '/models/kws/decoder.onnx',
        joiner: '/models/kws/joiner.onnx',
        tokens: '/models/kws/tokens.txt',
        keywords: '/models/kws/keywords.txt',
      },
    });
    native.initializeKeywordSpotting.mockResolvedValue({ success: true });
    native.unloadKeywordSpotting.mockResolvedValue(undefined);
  });

  it('detects paths, initializes defaults, and destroys idempotently', async () => {
    const engine = await createKeywordSpotting({
      modelSource: { kind: 'fs', path: '/archives/kws' },
    });

    expect(resolveModel).toHaveBeenCalledWith({
      kind: 'fs',
      path: '/archives/kws',
    });
    expect(detect).toHaveBeenCalledWith(
      { kind: 'fs', path: '/models/kws' },
      { quantization: undefined }
    );
    expect(native.initializeKeywordSpotting).toHaveBeenCalledWith(
      engine.instanceId,
      {
        encoder: '/models/kws/encoder.onnx',
        decoder: '/models/kws/decoder.onnx',
        joiner: '/models/kws/joiner.onnx',
        tokens: '/models/kws/tokens.txt',
        keywords: '/models/kws/keywords.txt',
        keywordsScore: 1.5,
        keywordsThreshold: 0.25,
        numTrailingBlanks: 2,
        maxActivePaths: 4,
      }
    );

    await engine.destroy();
    await engine.destroy();
    expect(native.unloadKeywordSpotting).toHaveBeenCalledTimes(1);
    expect(native.unloadKeywordSpotting).toHaveBeenCalledWith(
      engine.instanceId
    );
  });

  it('applies keyword path and tuning overrides', async () => {
    const engine = await createStreamingKWS({
      modelSource: { kind: 'fs', path: '/models/kws' },
      keywordsPath: '/custom/keywords.txt',
      keywordsScore: 2.5,
      keywordsThreshold: 0.1,
      numTrailingBlanks: 3,
      maxActivePaths: 8,
      numThreads: 2,
      provider: 'cpu',
      debug: true,
      quantization: 'int8',
    });

    expect(native.initializeKeywordSpotting).toHaveBeenCalledWith(
      engine.instanceId,
      expect.objectContaining({
        keywords: '/custom/keywords.txt',
        keywordsScore: 2.5,
        keywordsThreshold: 0.1,
        numTrailingBlanks: 3,
        maxActivePaths: 8,
        numThreads: 2,
        provider: 'cpu',
        debug: true,
      })
    );
  });

  it('fails before native initialization when detection fails', async () => {
    detect.mockResolvedValue({
      success: false,
      isStreaming: false,
      detectedModels: [],
      error: 'keywords.txt missing',
    });

    await expect(
      createKeywordSpotting({
        modelSource: { kind: 'fs', path: '/models/broken' },
      })
    ).rejects.toThrow('keywords.txt missing');
    expect(native.initializeKeywordSpotting).not.toHaveBeenCalled();
  });

  it('fails when detection omits required paths', async () => {
    detect.mockResolvedValue({
      success: true,
      isStreaming: true,
      detectedModels: [],
      paths: { encoder: '/models/kws/encoder.onnx' },
    });

    await expect(
      createKeywordSpotting({
        modelSource: { kind: 'fs', path: '/models/kws' },
      })
    ).rejects.toThrow('missing required paths');
    expect(native.initializeKeywordSpotting).not.toHaveBeenCalled();
  });

  it('fails when detection is not streaming', async () => {
    detect.mockResolvedValue({
      success: true,
      isStreaming: false,
      detectedModels: [],
      paths: {
        encoder: '/models/kws/encoder.onnx',
        decoder: '/models/kws/decoder.onnx',
        joiner: '/models/kws/joiner.onnx',
        tokens: '/models/kws/tokens.txt',
        keywords: '/models/kws/keywords.txt',
      },
    });

    await expect(
      createKeywordSpotting({
        modelSource: { kind: 'fs', path: '/models/kws' },
      })
    ).rejects.toThrow('streaming (online) KWS pack');
    expect(native.initializeKeywordSpotting).not.toHaveBeenCalled();
  });

  it('surfaces structured native initialization errors', async () => {
    native.initializeKeywordSpotting.mockResolvedValue({
      success: false,
      error: 'invalid model metadata',
    });

    await expect(
      createKeywordSpotting({
        modelSource: { kind: 'fs', path: '/models/kws' },
      })
    ).rejects.toThrow(
      'Keyword spotting initialization failed: invalid model metadata'
    );
  });
});
