jest.mock('../../detect/validateCustomModelPaths', () => {
  const helpers = jest.requireActual(
    '../../detect/customModelPathRequirements'
  );
  return {
    ...helpers,
    getCustomModelPathRequirements: jest.fn(async () => ({
      fields: [
        { key: 'encoder', required: true, kind: 'file' },
        { key: 'decoder', required: true, kind: 'file' },
        { key: 'joiner', required: true, kind: 'file' },
        { key: 'tokens', required: true, kind: 'file' },
        { key: 'keywords', required: true, kind: 'file' },
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
  assertKwsCustomConfig,
  resolveKwsCustomConfigPaths,
  KwsErrorCode,
} from '../customConfig';
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
} from '../../detect/validateCustomModelPaths';

const mockGetRequirements = getCustomModelPathRequirements as jest.Mock;
const mockValidate = validateCustomModelPaths as jest.Mock;

describe('assertKwsCustomConfig', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  it('accepts FileSource values', () => {
    expect(() =>
      assertKwsCustomConfig({
        encoder: fsPath('/encoder.onnx'),
        decoder: fsPath('/decoder.onnx'),
        joiner: fsPath('/joiner.onnx'),
        tokens: fsPath('/tokens.txt'),
        keywords: fsPath('/keywords.txt'),
      })
    ).not.toThrow();
  });

  it('throws KWS_INVALID_ARGUMENT when a value is not a FileSource', () => {
    expect(() =>
      assertKwsCustomConfig({
        encoder: '/encoder.onnx',
      })
    ).toThrow(KwsErrorCode.INVALID_ARGUMENT);
  });
});

describe('resolveKwsCustomConfigPaths', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequirements.mockResolvedValue({
      fields: [
        { key: 'encoder', required: true, kind: 'file' },
        { key: 'decoder', required: true, kind: 'file' },
        { key: 'joiner', required: true, kind: 'file' },
        { key: 'tokens', required: true, kind: 'file' },
        { key: 'keywords', required: true, kind: 'file' },
      ],
    });
    mockValidate.mockResolvedValue({ ok: true });
  });

  it('rejects unknown keys using native schema', async () => {
    await expect(
      resolveKwsCustomConfigPaths('transducer', {
        encoder: fsPath('/encoder.onnx'),
        decoder: fsPath('/decoder.onnx'),
        joiner: fsPath('/joiner.onnx'),
        tokens: fsPath('/tokens.txt'),
        keywords: fsPath('/keywords.txt'),
        unknownKey: fsPath('/x.onnx'),
      } as never)
    ).rejects.toThrow(KwsErrorCode.INVALID_ARGUMENT);
  });

  it('resolves paths via shared resolver', async () => {
    const paths = await resolveKwsCustomConfigPaths('transducer', {
      encoder: fsPath('/encoder.onnx'),
      decoder: fsPath('/decoder.onnx'),
      joiner: fsPath('/joiner.onnx'),
      tokens: fsPath('/tokens.txt'),
      keywords: fsPath('/keywords.txt'),
    });
    expect(paths).toEqual({
      encoder: '/encoder.onnx',
      decoder: '/decoder.onnx',
      joiner: '/joiner.onnx',
      tokens: '/tokens.txt',
      keywords: '/keywords.txt',
    });
    expect(mockValidate).toHaveBeenCalledWith(
      'kws',
      'transducer',
      expect.objectContaining({ encoder: '/encoder.onnx' })
    );
  });
});
