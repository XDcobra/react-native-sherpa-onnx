jest.mock('../../detect/validateCustomModelPaths', () => {
  const helpers = jest.requireActual(
    '../../detect/customModelPathRequirements'
  );
  return {
    ...helpers,
    getCustomModelPathRequirements: jest.fn(async () => ({
      fields: [
        { key: 'ttsModel', required: true, kind: 'file' },
        { key: 'tokens', required: true, kind: 'file' },
        { key: 'lexicon', required: false, kind: 'file' },
      ],
    })),
    validateCustomModelPaths: jest.fn(async () => ({ ok: true })),
  };
});

jest.mock('../../detect/resolveModelInput', () => ({
  resolveModelFileSources: jest.fn(async (sources: Record<string, unknown>) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(sources)) {
      const path = (value as { path?: string })?.path;
      if (path) out[key] = path;
    }
    return out;
  }),
}));

import {
  assertTtsCustomConfig,
  resolveTtsCustomConfigPaths,
} from '../customConfig';
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
} from '../../detect/validateCustomModelPaths';
import { TtsErrorCode } from '../customConfig';

const mockGetRequirements = getCustomModelPathRequirements as jest.Mock;
const mockValidate = validateCustomModelPaths as jest.Mock;

describe('assertTtsCustomConfig', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  it('accepts FileSource values', () => {
    expect(() =>
      assertTtsCustomConfig({
        ttsModel: fsPath('/model.onnx'),
        tokens: fsPath('/tokens.txt'),
      })
    ).not.toThrow();
  });

  it('throws TTS_INVALID_ARGUMENT when a value is not a FileSource', () => {
    expect(() =>
      assertTtsCustomConfig({
        ttsModel: '/model.onnx',
      })
    ).toThrow(TtsErrorCode.INVALID_ARGUMENT);
  });
});

describe('resolveTtsCustomConfigPaths', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequirements.mockResolvedValue({
      fields: [
        { key: 'ttsModel', required: true, kind: 'file' },
        { key: 'tokens', required: true, kind: 'file' },
        { key: 'lexicon', required: false, kind: 'file' },
      ],
    });
    mockValidate.mockResolvedValue({ ok: true });
  });

  it('rejects unknown keys using native schema', async () => {
    await expect(
      resolveTtsCustomConfigPaths('vits', {
        ttsModel: fsPath('/model.onnx'),
        tokens: fsPath('/tokens.txt'),
        unknownKey: fsPath('/x.onnx'),
      } as never)
    ).rejects.toThrow(TtsErrorCode.INVALID_ARGUMENT);
  });

  it('resolves paths via shared resolver', async () => {
    const paths = await resolveTtsCustomConfigPaths('vits', {
      ttsModel: fsPath('/model.onnx'),
      tokens: fsPath('/tokens.txt'),
    });
    expect(paths).toEqual({
      ttsModel: '/model.onnx',
      tokens: '/tokens.txt',
    });
    expect(mockValidate).toHaveBeenCalled();
  });

  it('rejects dataDir for vits after espeak removal', async () => {
    await expect(
      resolveTtsCustomConfigPaths('vits', {
        ttsModel: fsPath('/model.onnx'),
        tokens: fsPath('/tokens.txt'),
        dataDir: fsPath('/espeak-ng-data'),
      } as never)
    ).rejects.toThrow(TtsErrorCode.INVALID_ARGUMENT);
  });

  it('accepts optional Kitten lexicon and rejects dataDir', async () => {
    mockGetRequirements.mockResolvedValue({
      fields: [
        { key: 'ttsModel', required: true, kind: 'file' },
        { key: 'tokens', required: true, kind: 'file' },
        { key: 'voices', required: true, kind: 'file' },
        { key: 'lexicon', required: false, kind: 'file' },
      ],
    });
    const paths = await resolveTtsCustomConfigPaths('kitten', {
      ttsModel: fsPath('/kitten.onnx'),
      tokens: fsPath('/tokens.txt'),
      voices: fsPath('/voices.bin'),
      lexicon: fsPath('/lexicon-en-us.txt'),
    });
    expect(paths).toEqual({
      ttsModel: '/kitten.onnx',
      tokens: '/tokens.txt',
      voices: '/voices.bin',
      lexicon: '/lexicon-en-us.txt',
    });
    await expect(
      resolveTtsCustomConfigPaths('kitten', {
        ttsModel: fsPath('/kitten.onnx'),
        tokens: fsPath('/tokens.txt'),
        voices: fsPath('/voices.bin'),
        dataDir: fsPath('/espeak-ng-data'),
      } as never)
    ).rejects.toThrow(TtsErrorCode.INVALID_ARGUMENT);
  });

  it('accepts zipvoice customConfig without dataDir', async () => {
    mockGetRequirements.mockResolvedValue({
      fields: [
        { key: 'encoder', required: true, kind: 'file' },
        { key: 'decoder', required: true, kind: 'file' },
        { key: 'vocoder', required: true, kind: 'file' },
        { key: 'tokens', required: true, kind: 'file' },
        { key: 'lexicon', required: false, kind: 'file' },
      ],
    });
    const paths = await resolveTtsCustomConfigPaths('zipvoice', {
      encoder: fsPath('/enc.onnx'),
      decoder: fsPath('/dec.onnx'),
      vocoder: fsPath('/voc.onnx'),
      tokens: fsPath('/tokens.txt'),
    });
    expect(paths).toEqual({
      encoder: '/enc.onnx',
      decoder: '/dec.onnx',
      vocoder: '/voc.onnx',
      tokens: '/tokens.txt',
    });
  });
});
