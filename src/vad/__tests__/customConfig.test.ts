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
  assertVadCustomConfig,
  resolveVadCustomConfigPaths,
} from '../customConfig';
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
} from '../../detect/validateCustomModelPaths';
import { VadErrorCode } from '../customConfig';

const mockGetRequirements = getCustomModelPathRequirements as jest.Mock;
const mockValidate = validateCustomModelPaths as jest.Mock;

describe('assertVadCustomConfig', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  it('accepts FileSource values', () => {
    expect(() =>
      assertVadCustomConfig({
        model: fsPath('/silero_vad.onnx'),
      })
    ).not.toThrow();
  });

  it('throws VAD_INVALID_ARGUMENT when a value is not a FileSource', () => {
    expect(() =>
      assertVadCustomConfig({
        model: '/silero_vad.onnx',
      })
    ).toThrow(VadErrorCode.INVALID_ARGUMENT);
  });
});

describe('resolveVadCustomConfigPaths', () => {
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
      resolveVadCustomConfigPaths('silero_vad', {
        model: fsPath('/silero_vad.onnx'),
        unknownKey: fsPath('/x.onnx'),
      } as never)
    ).rejects.toThrow(VadErrorCode.INVALID_ARGUMENT);
  });

  it('resolves paths via shared resolver', async () => {
    const paths = await resolveVadCustomConfigPaths('ten_vad', {
      model: fsPath('/ten_vad.onnx'),
    });
    expect(paths).toEqual({ model: '/ten_vad.onnx' });
    expect(mockValidate).toHaveBeenCalled();
  });
});
