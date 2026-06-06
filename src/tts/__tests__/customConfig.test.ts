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
        { key: 'dataDir', required: false, kind: 'dir' },
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
        { key: 'dataDir', required: false, kind: 'dir' },
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
});
