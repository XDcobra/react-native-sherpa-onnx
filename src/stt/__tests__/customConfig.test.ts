jest.mock('../../detect/validateCustomModelPaths', () => ({
  getCustomModelPathRequirements: jest.fn(async () => ({
    required: ['encoder', 'decoder', 'joiner', 'tokens'],
    optional: ['bpeVocab'],
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
  assertSttCustomConfig,
  resolveSttCustomConfigPaths,
} from '../customConfig';
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
} from '../../detect/validateCustomModelPaths';
import { SttErrorCode } from '../types';

const mockGetRequirements = getCustomModelPathRequirements as jest.Mock;
const mockValidate = validateCustomModelPaths as jest.Mock;

describe('assertSttCustomConfig', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  it('accepts FileSource values', () => {
    expect(() =>
      assertSttCustomConfig({
        encoder: fsPath('/enc.onnx'),
        decoder: fsPath('/dec.onnx'),
      })
    ).not.toThrow();
  });

  it('throws STT_INVALID_ARGUMENT when a value is not a FileSource', () => {
    expect(() =>
      assertSttCustomConfig({
        encoder: '/enc.onnx',
      })
    ).toThrow(SttErrorCode.INVALID_ARGUMENT);
  });
});

describe('resolveSttCustomConfigPaths', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequirements.mockResolvedValue({
      required: ['whisperEncoder', 'whisperDecoder', 'tokens'],
      optional: [],
    });
    mockValidate.mockResolvedValue({ ok: true });
  });

  it('rejects unknown keys using native schema', async () => {
    mockGetRequirements.mockResolvedValueOnce({
      required: ['encoder', 'decoder', 'joiner', 'tokens'],
      optional: [],
    });

    await expect(
      resolveSttCustomConfigPaths('transducer', {
        encoder: fsPath('/enc.onnx'),
        decoder: fsPath('/dec.onnx'),
        joiner: fsPath('/join.onnx'),
        tokens: fsPath('/tokens.txt'),
        unknownKey: fsPath('/x.onnx'),
      } as never)
    ).rejects.toThrow(SttErrorCode.INVALID_ARGUMENT);
  });

  it('throws when native validation fails', async () => {
    mockValidate.mockResolvedValueOnce({
      ok: false,
      error: 'STT Whisper: missing required files',
      missingRequired: ['whisperDecoder'],
    });

    await expect(
      resolveSttCustomConfigPaths('whisper', {
        whisperEncoder: fsPath('/enc.onnx'),
        tokens: fsPath('/tokens.txt'),
      } as never)
    ).rejects.toThrow(SttErrorCode.INVALID_ARGUMENT);
  });
});
