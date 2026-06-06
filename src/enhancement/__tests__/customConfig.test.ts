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
  assertEnhancementCustomConfig,
  resolveEnhancementCustomConfigPaths,
  EnhancementErrorCode,
} from '../customConfig';
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
} from '../../detect/validateCustomModelPaths';

const mockGetRequirements = getCustomModelPathRequirements as jest.Mock;
const mockValidate = validateCustomModelPaths as jest.Mock;

describe('assertEnhancementCustomConfig', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  it('accepts FileSource values', () => {
    expect(() =>
      assertEnhancementCustomConfig({
        model: fsPath('/gtcrn.onnx'),
      })
    ).not.toThrow();
  });

  it('throws ENHANCEMENT_INVALID_ARGUMENT when a value is not a FileSource', () => {
    expect(() =>
      assertEnhancementCustomConfig({
        model: '/gtcrn.onnx',
      })
    ).toThrow(EnhancementErrorCode.INVALID_ARGUMENT);
  });
});

describe('resolveEnhancementCustomConfigPaths', () => {
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
      resolveEnhancementCustomConfigPaths('gtcrn', {
        model: fsPath('/gtcrn.onnx'),
        unknownKey: fsPath('/x.onnx'),
      } as never)
    ).rejects.toThrow(EnhancementErrorCode.INVALID_ARGUMENT);
  });

  it('resolves paths via shared resolver', async () => {
    const paths = await resolveEnhancementCustomConfigPaths('dpdfnet', {
      model: fsPath('/dpdfnet.onnx'),
    });
    expect(paths).toEqual({ model: '/dpdfnet.onnx' });
    expect(mockValidate).toHaveBeenCalled();
  });
});
