jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeLanguageId: jest.fn(),
    identifyLanguageOffline: jest.fn(),
    unloadLanguageId: jest.fn(),
    detectLanguageIdModel: jest.fn(),
    getCustomModelPathRequirements: jest.fn(async () => ({
      category: 'languageId',
      modelType: 'whisper',
      fields: [
        { key: 'encoder', required: true, description: 'Whisper encoder' },
        { key: 'decoder', required: true, description: 'Whisper decoder' },
      ],
    })),
    validateCustomModelPaths: jest.fn(async () => ({
      ok: true,
      category: 'languageId',
      modelType: 'whisper',
      errors: [],
      missingRequired: [],
      unknownFields: [],
      fields: {},
    })),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/whisper-tiny',
    assetName: 'sherpa-onnx-whisper-tiny',
  })),
  resolveFileSourceForModelInit: jest.fn(async (source: any) => {
    if (typeof source === 'string') return source;
    return source.path ?? '/resolved/path';
  }),
  resolveModelFileSources: jest.fn(async (map: Record<string, any>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      out[k] = v.path ?? `/resolved/${k}`;
    }
    return out;
  }),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createLanguageIdentification, LanguageIdErrorCode } from '../index';

describe('createLanguageIdentification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('initializes engine successfully using auto modelSource', async () => {
    (SherpaOnnx.detectLanguageIdModel as jest.Mock).mockResolvedValue({
      success: true,
      modelType: 'whisper',
      quantization: 'int8',
      paths: {
        encoder: '/models/whisper-tiny/tiny-encoder.int8.onnx',
        decoder: '/models/whisper-tiny/tiny-decoder.int8.onnx',
      },
      detectedModels: [{ type: 'whisper', modelDir: '/models/whisper-tiny' }],
    });

    (SherpaOnnx.initializeLanguageId as jest.Mock).mockResolvedValue({
      success: true,
    });

    const engine = await createLanguageIdentification({
      modelSource: { kind: 'fs', path: '/models/whisper-tiny' },
      quantization: 'int8',
      numThreads: 2,
      provider: 'cpu',
      tailPaddings: 500,
      debug: false,
    });

    expect(engine.instanceId).toMatch(/^lang_id_\d+_\d+$/);
    expect(SherpaOnnx.initializeLanguageId).toHaveBeenCalledWith(
      engine.instanceId,
      {
        encoder: '/models/whisper-tiny/tiny-encoder.int8.onnx',
        decoder: '/models/whisper-tiny/tiny-decoder.int8.onnx',
        numThreads: 2,
        provider: 'cpu',
        tailPaddings: 500,
        debug: false,
      }
    );
  });

  it('initializes engine successfully using customConfig', async () => {
    (SherpaOnnx.initializeLanguageId as jest.Mock).mockResolvedValue({
      success: true,
    });

    const engine = await createLanguageIdentification({
      customConfig: {
        encoder: { kind: 'fs', path: '/custom/encoder.onnx' },
        decoder: { kind: 'fs', path: '/custom/decoder.onnx' },
      },
      numThreads: 4,
    });

    expect(engine.instanceId).toBeDefined();
    expect(SherpaOnnx.initializeLanguageId).toHaveBeenCalledWith(
      engine.instanceId,
      {
        encoder: '/custom/encoder.onnx',
        decoder: '/custom/decoder.onnx',
        numThreads: 4,
      }
    );
  });

  it('rejects if neither modelSource nor customConfig is provided', async () => {
    await expect(createLanguageIdentification({} as any)).rejects.toThrow(
      LanguageIdErrorCode.INVALID_ARGUMENT
    );
  });

  it('rejects if both modelSource and customConfig are provided', async () => {
    await expect(
      createLanguageIdentification({
        modelSource: { kind: 'fs', path: '/models/whisper' },
        customConfig: {
          encoder: { kind: 'fs', path: '/e.onnx' },
          decoder: { kind: 'fs', path: '/d.onnx' },
        },
      } as any)
    ).rejects.toThrow(LanguageIdErrorCode.INVALID_ARGUMENT);
  });

  it('rejects if model detection fails', async () => {
    (SherpaOnnx.detectLanguageIdModel as jest.Mock).mockResolvedValue({
      success: false,
      error: 'No valid Whisper model found',
    });

    await expect(
      createLanguageIdentification({
        modelSource: { kind: 'fs', path: '/invalid' },
      })
    ).rejects.toThrow(LanguageIdErrorCode.INIT_FAILED);
  });

  it('rejects if native initialization fails', async () => {
    (SherpaOnnx.detectLanguageIdModel as jest.Mock).mockResolvedValue({
      success: true,
      paths: {
        encoder: '/e.onnx',
        decoder: '/d.onnx',
      },
    });

    (SherpaOnnx.initializeLanguageId as jest.Mock).mockResolvedValue({
      success: false,
      error: 'Failed to allocate ONNX session',
    });

    await expect(
      createLanguageIdentification({
        modelSource: { kind: 'fs', path: '/models/whisper' },
      })
    ).rejects.toThrow(LanguageIdErrorCode.INIT_FAILED);
  });

  describe('identify (oneshot)', () => {
    let engine: any;

    beforeEach(async () => {
      (SherpaOnnx.detectLanguageIdModel as jest.Mock).mockResolvedValue({
        success: true,
        paths: { encoder: '/e.onnx', decoder: '/d.onnx' },
      });
      (SherpaOnnx.initializeLanguageId as jest.Mock).mockResolvedValue({
        success: true,
      });

      engine = await createLanguageIdentification({
        modelSource: { kind: 'fs', path: '/models/whisper' },
      });
    });

    it('evaluates language from offline audio buffer ID', async () => {
      (SherpaOnnx.identifyLanguageOffline as jest.Mock).mockResolvedValue({
        lang: 'de',
        audioDuration: 4.5,
        elapsedMs: 85,
      });

      const res = await engine.identify(
        'off_11111111-1111-1111-1111-111111111111'
      );

      expect(SherpaOnnx.identifyLanguageOffline).toHaveBeenCalledWith(
        engine.instanceId,
        'off_11111111-1111-1111-1111-111111111111',
        null,
        null
      );
      expect(res).toEqual({
        lang: 'de',
        audioDuration: 4.5,
        elapsedMs: 85,
      });
    });

    it('evaluates language from OfflineAudioBufferRef object', async () => {
      (SherpaOnnx.identifyLanguageOffline as jest.Mock).mockResolvedValue({
        lang: 'en',
        audioDuration: 2.1,
        elapsedMs: 40,
      });

      const bufferRef = {
        bufferId: 'off_22222222-2222-2222-2222-222222222222',
        info: {
          bufferId: 'off_22222222-2222-2222-2222-222222222222',
          kind: 'offlineAudioBuffer',
        },
      };

      const res = await engine.identify(bufferRef);

      expect(SherpaOnnx.identifyLanguageOffline).toHaveBeenCalledWith(
        engine.instanceId,
        'off_22222222-2222-2222-2222-222222222222',
        null,
        null
      );
      expect(res.lang).toBe('en');
    });

    it('throws when audio buffer is invalid or not an offline buffer', async () => {
      await expect(engine.identify(null as any)).rejects.toThrow(
        LanguageIdErrorCode.INVALID_ARGUMENT
      );
      await expect(
        engine.identify('live_33333333-3333-3333-3333-333333333333' as any)
      ).rejects.toThrow(LanguageIdErrorCode.INVALID_ARGUMENT);
      await expect(engine.identify('not_even_an_id' as any)).rejects.toThrow(
        LanguageIdErrorCode.INVALID_ARGUMENT
      );
    });

    it('unloads native resources on destroy and prevents subsequent identify calls', async () => {
      (SherpaOnnx.unloadLanguageId as jest.Mock).mockResolvedValue(undefined);

      await engine.destroy();

      expect(SherpaOnnx.unloadLanguageId).toHaveBeenCalledWith(
        engine.instanceId
      );

      await expect(
        engine.identify('off_11111111-1111-1111-1111-111111111111')
      ).rejects.toThrow(LanguageIdErrorCode.DESTROYED);
    });

    it('destroy is idempotent', async () => {
      (SherpaOnnx.unloadLanguageId as jest.Mock).mockResolvedValue(undefined);

      await engine.destroy();
      await engine.destroy();

      expect(SherpaOnnx.unloadLanguageId).toHaveBeenCalledTimes(1);
    });
  });
});
