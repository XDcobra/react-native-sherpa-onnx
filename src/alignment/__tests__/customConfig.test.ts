jest.mock('../../detect/validateCustomModelPaths', () => ({
  getCustomModelPathRequirements: jest.fn(async () => ({
    required: ['model'],
    optional: [],
  })),
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
  assertAlignmentCustomConfig,
  resolveAlignmentCustomConfigPaths,
  AlignmentErrorCode,
} from '../customConfig';
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
} from '../../detect/validateCustomModelPaths';

const mockGetRequirements = getCustomModelPathRequirements as jest.Mock;
const mockValidate = validateCustomModelPaths as jest.Mock;

describe('assertAlignmentCustomConfig', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  it('accepts FileSource values', () => {
    expect(() =>
      assertAlignmentCustomConfig({
        model: fsPath('/wav2vec2.onnx'),
      })
    ).not.toThrow();
  });

  it('throws ALIGNMENT_INVALID_ARGUMENT when a value is not a FileSource', () => {
    expect(() =>
      assertAlignmentCustomConfig({
        model: '/wav2vec2.onnx',
      })
    ).toThrow(AlignmentErrorCode.INVALID_ARGUMENT);
  });
});

describe('resolveAlignmentCustomConfigPaths', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequirements.mockResolvedValue({
      required: ['model'],
      optional: [],
    });
    mockValidate.mockResolvedValue({ ok: true });
  });

  it('rejects unknown keys using native schema', async () => {
    await expect(
      resolveAlignmentCustomConfigPaths('wav2vec2', {
        model: fsPath('/wav2vec2.onnx'),
        unknownKey: fsPath('/x.onnx'),
      } as never)
    ).rejects.toThrow(AlignmentErrorCode.INVALID_ARGUMENT);
  });

  it('resolves paths via shared resolver', async () => {
    const paths = await resolveAlignmentCustomConfigPaths('wav2vec2', {
      model: fsPath('/wav2vec2.onnx'),
    });
    expect(paths).toEqual({ model: '/wav2vec2.onnx' });
    expect(mockValidate).toHaveBeenCalled();
  });
});
