jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectLanguageIdModel: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/language-id',
    assetName: 'sherpa-onnx-whisper-tiny',
  })),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => [
    { iso6391Hint: 'en', id: 'en' },
    { iso6391Hint: 'de', id: 'de' },
  ]),
  readPublicLanguageRows: jest.fn(() => []),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { detectLanguageIdModel } from '../index';

describe('detectLanguageIdModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps native encoder and decoder paths into result', async () => {
    (SherpaOnnx.detectLanguageIdModel as jest.Mock).mockResolvedValue({
      success: true,
      isStreaming: false,
      modelType: 'whisper',
      quantization: 'int8',
      detectedModels: [{ type: 'whisper', modelDir: '/models/language-id' }],
      detectionSources: ['fileListing', 'curatedCatalog'],
      paths: {
        encoder: '/models/language-id/tiny-encoder.int8.onnx',
        decoder: '/models/language-id/tiny-decoder.int8.onnx',
      },
    });

    const result = await detectLanguageIdModel({
      kind: 'fs',
      path: '/models/language-id',
    });

    expect(result.success).toBe(true);
    expect(result.isStreaming).toBe(false);
    expect(result.modelType).toBe('whisper');
    expect(result.quantization).toBe('int8');
    expect(result.paths).toEqual({
      encoder: '/models/language-id/tiny-encoder.int8.onnx',
      decoder: '/models/language-id/tiny-decoder.int8.onnx',
    });
    expect(result.detectedModels).toEqual([
      { type: 'whisper', modelDir: '/models/language-id' },
    ]);
    expect(result.detectionSources).toEqual(['fileListing', 'curatedCatalog']);
    expect(result.languages).toEqual([
      { iso6391Hint: 'en', id: 'en' },
      { iso6391Hint: 'de', id: 'de' },
    ]);
  });

  it('passes explicit options (modelType, quantization, assetName) to native bridge', async () => {
    (SherpaOnnx.detectLanguageIdModel as jest.Mock).mockResolvedValue({
      success: true,
      isStreaming: false,
      modelType: 'whisper',
      detectedModels: [],
      paths: {
        encoder: '/m/encoder.onnx',
        decoder: '/m/decoder.onnx',
      },
    });

    await detectLanguageIdModel(
      { kind: 'fs', path: '/custom/dir' },
      {
        modelType: 'whisper',
        quantization: 'fp16',
        assetName: 'custom-asset-name',
      }
    );

    expect(SherpaOnnx.detectLanguageIdModel).toHaveBeenCalledWith(
      '/models/language-id',
      'custom-asset-name',
      'whisper',
      'fp16'
    );
  });

  it('handles error response and omits empty paths', async () => {
    (SherpaOnnx.detectLanguageIdModel as jest.Mock).mockResolvedValue({
      success: false,
      isStreaming: false,
      error: 'LanguageId: no compatible model type detected',
      detectedModels: [],
      paths: {
        encoder: '',
        decoder: '   ',
      },
    });

    const result = await detectLanguageIdModel({
      kind: 'fs',
      path: '/models/empty',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('LanguageId: no compatible model type detected');
    expect(result.paths).toBeUndefined();
  });
});
