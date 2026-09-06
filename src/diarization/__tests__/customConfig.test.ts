jest.mock('../../detect/validateCustomModelPaths', () => {
  const helpers = jest.requireActual(
    '../../detect/customModelPathRequirements'
  );
  return {
    ...helpers,
    getCustomModelPathRequirements: jest.fn(async () => ({
      fields: [
        { key: 'model', required: true, kind: 'file' },
        { key: 'metadata', required: false, kind: 'file' },
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
  assertDiarizationCustomConfig,
  resolveDiarizationCustomConfigPaths,
} from '../customConfig';
import { DiarizationErrorCode } from '../types';
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
} from '../../detect/validateCustomModelPaths';

const mockGetRequirements = getCustomModelPathRequirements as jest.Mock;
const mockValidate = validateCustomModelPaths as jest.Mock;

describe('assertDiarizationCustomConfig', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  it('accepts FileSource values with model only', () => {
    expect(() =>
      assertDiarizationCustomConfig({
        model: fsPath('/models/model.onnx'),
      })
    ).not.toThrow();
  });

  it('accepts FileSource values with model and metadata', () => {
    expect(() =>
      assertDiarizationCustomConfig({
        model: fsPath('/models/model.onnx'),
        metadata: fsPath('/models/metadata.json'),
      })
    ).not.toThrow();
  });

  it('throws DIARIZATION_INVALID_ARGUMENT when a value is not a FileSource', () => {
    expect(() =>
      assertDiarizationCustomConfig({
        model: '/models/model.onnx',
      })
    ).toThrow(DiarizationErrorCode.INVALID_ARGUMENT);
  });
});

describe('resolveDiarizationCustomConfigPaths', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequirements.mockResolvedValue({
      fields: [
        { key: 'model', required: true, kind: 'file' },
        { key: 'metadata', required: false, kind: 'file' },
      ],
    });
    mockValidate.mockResolvedValue({ ok: true });
  });

  it('rejects unknown keys using native schema', async () => {
    mockGetRequirements.mockResolvedValue({
      fields: [{ key: 'model', required: true, kind: 'file' }],
    });

    await expect(
      resolveDiarizationCustomConfigPaths('pyannote', {
        model: fsPath('/models/model.onnx'),
        unexpectedField: fsPath('/models/other.onnx'),
      } as never)
    ).rejects.toThrow(DiarizationErrorCode.INVALID_ARGUMENT);
  });

  it('resolves model only for sortformer when metadata is omitted', async () => {
    const paths = await resolveDiarizationCustomConfigPaths('sortformer', {
      model: fsPath('/models/sortformer.onnx'),
    });
    expect(paths).toEqual({ model: '/models/sortformer.onnx' });
    expect(mockValidate).toHaveBeenCalledWith('diarization', 'sortformer', {
      model: '/models/sortformer.onnx',
    });
  });

  it('resolves both model and metadata for sortformer when provided', async () => {
    const paths = await resolveDiarizationCustomConfigPaths('sortformer', {
      model: fsPath('/models/sortformer.onnx'),
      metadata: fsPath('/models/metadata.json'),
    });
    expect(paths).toEqual({
      model: '/models/sortformer.onnx',
      metadata: '/models/metadata.json',
    });
    expect(mockValidate).toHaveBeenCalledWith('diarization', 'sortformer', {
      model: '/models/sortformer.onnx',
      metadata: '/models/metadata.json',
    });
  });

  it('rejects when validation fails (e.g. missing required model)', async () => {
    mockValidate.mockResolvedValue({
      ok: false,
      error: 'Diarization sortformer: missing required files: model',
      missingRequired: ['model'],
    });

    await expect(
      resolveDiarizationCustomConfigPaths('sortformer', {
        metadata: fsPath('/models/metadata.json'),
      } as never)
    ).rejects.toThrow(DiarizationErrorCode.INVALID_ARGUMENT);
  });
});
