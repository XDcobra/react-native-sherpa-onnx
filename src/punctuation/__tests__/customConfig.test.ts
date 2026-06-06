jest.mock('../../detect/validateCustomModelPaths', () => ({
  getCustomModelPathRequirements: jest.fn(
    async (_category: string, modelType: string) => {
      if (modelType === 'ct_transformer') {
        return { required: ['ct_transformer'], optional: [] };
      }
      return { required: ['cnn_bilstm', 'bpe_vocab'], optional: [] };
    }
  ),
  validateCustomModelPaths: jest.fn(async () => ({ ok: true })),
}));

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
  assertOfflinePunctuationCustomConfig,
  assertStreamingPunctuationCustomConfig,
  resolveOfflinePunctuationCustomConfigPaths,
  resolveStreamingPunctuationCustomConfigPaths,
  PunctuationErrorCode,
} from '../customConfig';
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
} from '../../detect/validateCustomModelPaths';

const mockGetRequirements = getCustomModelPathRequirements as jest.Mock;
const mockValidate = validateCustomModelPaths as jest.Mock;

describe('assertOfflinePunctuationCustomConfig', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  it('accepts FileSource values', () => {
    expect(() =>
      assertOfflinePunctuationCustomConfig({
        ct_transformer: fsPath('/ct.onnx'),
      })
    ).not.toThrow();
  });

  it('throws PUNCTUATION_INVALID_ARGUMENT when a value is not a FileSource', () => {
    expect(() =>
      assertOfflinePunctuationCustomConfig({
        ct_transformer: '/ct.onnx',
      })
    ).toThrow(PunctuationErrorCode.INVALID_ARGUMENT);
  });
});

describe('assertStreamingPunctuationCustomConfig', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  it('accepts FileSource values', () => {
    expect(() =>
      assertStreamingPunctuationCustomConfig({
        cnn_bilstm: fsPath('/cnn.onnx'),
        bpe_vocab: fsPath('/bpe.vocab'),
      })
    ).not.toThrow();
  });
});

describe('resolveOfflinePunctuationCustomConfigPaths', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequirements.mockResolvedValue({
      required: ['ct_transformer'],
      optional: [],
    });
    mockValidate.mockResolvedValue({ ok: true });
  });

  it('rejects unknown keys using native schema', async () => {
    await expect(
      resolveOfflinePunctuationCustomConfigPaths('ct_transformer', {
        ct_transformer: fsPath('/ct.onnx'),
        unknownKey: fsPath('/x.onnx'),
      } as never)
    ).rejects.toThrow(PunctuationErrorCode.INVALID_ARGUMENT);
  });

  it('resolves paths via shared resolver', async () => {
    const paths = await resolveOfflinePunctuationCustomConfigPaths(
      'ct_transformer',
      {
        ct_transformer: fsPath('/ct.onnx'),
      }
    );
    expect(paths).toEqual({ ct_transformer: '/ct.onnx' });
    expect(mockValidate).toHaveBeenCalled();
  });
});

describe('resolveStreamingPunctuationCustomConfigPaths', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequirements.mockResolvedValue({
      required: ['cnn_bilstm', 'bpe_vocab'],
      optional: [],
    });
    mockValidate.mockResolvedValue({ ok: true });
  });

  it('resolves both streaming paths', async () => {
    const paths = await resolveStreamingPunctuationCustomConfigPaths(
      'cnn_bilstm',
      {
        cnn_bilstm: fsPath('/cnn.onnx'),
        bpe_vocab: fsPath('/bpe.vocab'),
      }
    );
    expect(paths).toEqual({
      cnn_bilstm: '/cnn.onnx',
      bpe_vocab: '/bpe.vocab',
    });
  });
});
