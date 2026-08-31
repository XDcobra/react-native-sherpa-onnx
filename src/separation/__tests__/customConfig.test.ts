jest.mock('../../detect/validateCustomModelPaths', () => {
  const helpers = jest.requireActual(
    '../../detect/customModelPathRequirements'
  );
  return {
    ...helpers,
    getCustomModelPathRequirements: jest.fn(async (_category, modelType) => {
      if (modelType === 'spleeter') {
        return {
          fields: [
            { key: 'vocals', required: true, kind: 'file' },
            { key: 'accompaniment', required: true, kind: 'file' },
          ],
        };
      }
      return {
        fields: [{ key: 'model', required: true, kind: 'file' }],
      };
    }),
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
  assertSeparationCustomConfig,
  resolveSeparationCustomConfigPaths,
  resolveSpleeterCustomConfigPaths,
  resolveUvrCustomConfigPaths,
  SeparationErrorCode,
} from '../customConfig';
import { validateCustomModelPaths } from '../../detect/validateCustomModelPaths';

const mockValidate = validateCustomModelPaths as jest.Mock;

describe('assertSeparationCustomConfig', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  it('accepts FileSource values', () => {
    expect(() =>
      assertSeparationCustomConfig({
        vocals: fsPath('/vocals.onnx'),
        accompaniment: fsPath('/accompaniment.onnx'),
      })
    ).not.toThrow();
  });

  it('throws SEPARATION_INVALID_ARGUMENT when a value is not a FileSource', () => {
    expect(() =>
      assertSeparationCustomConfig({
        model: '/UVR.onnx',
      })
    ).toThrow(SeparationErrorCode.INVALID_ARGUMENT);
  });
});

describe('resolveSeparation custom config paths', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidate.mockResolvedValue({ ok: true });
  });

  it('resolves Spleeter paths', async () => {
    const paths = await resolveSpleeterCustomConfigPaths({
      vocals: fsPath('/vocals.onnx'),
      accompaniment: fsPath('/accompaniment.onnx'),
    });
    expect(paths).toEqual({
      vocals: '/vocals.onnx',
      accompaniment: '/accompaniment.onnx',
    });
    expect(mockValidate).toHaveBeenCalledWith('separation', 'spleeter', paths);
  });

  it('resolves UVR paths', async () => {
    const paths = await resolveUvrCustomConfigPaths({
      model: fsPath('/UVR-MDX-NET-Inst_1.onnx'),
    });
    expect(paths).toEqual({ model: '/UVR-MDX-NET-Inst_1.onnx' });
  });

  it('dispatches by modelType', async () => {
    const paths = await resolveSeparationCustomConfigPaths('uvr', {
      model: fsPath('/UVR.onnx'),
    });
    expect(paths).toEqual({ model: '/UVR.onnx' });
  });
});
