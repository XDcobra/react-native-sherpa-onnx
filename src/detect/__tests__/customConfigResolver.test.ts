jest.mock('../resolveModelInput', () => ({
  resolveModelFileSources: jest.fn(
    async (sources: Record<string, { path: string }>) =>
      Object.fromEntries(
        Object.entries(sources).map(([key, value]) => [key, value.path])
      )
  ),
}));

jest.mock('../validateCustomModelPaths', () => ({
  getCustomModelPathRequirements: jest.fn(async () => ({
    required: ['encoder', 'decoder', 'joiner', 'tokens'],
    optional: ['bpeVocab'],
  })),
  validateCustomModelPaths: jest.fn(async () => ({ ok: true })),
}));

import {
  assertCustomModelConfig,
  isFileSource,
  resolveCustomModelConfigPaths,
} from '../customConfigResolver';
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
} from '../validateCustomModelPaths';
import { ModelCategory } from '../../download/types';

const mockGetRequirements = getCustomModelPathRequirements as jest.Mock;
const mockValidate = validateCustomModelPaths as jest.Mock;

describe('isFileSource', () => {
  it('accepts FileSource objects', () => {
    expect(isFileSource({ kind: 'fs', path: '/x' })).toBe(true);
  });

  it('rejects plain strings', () => {
    expect(isFileSource('/x')).toBe(false);
  });
});

describe('assertCustomModelConfig', () => {
  it('throws with the provided error code', () => {
    expect(() =>
      assertCustomModelConfig({ tokens: '/bad' }, 'TEST_INVALID')
    ).toThrow('TEST_INVALID');
  });
});

describe('resolveCustomModelConfigPaths', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequirements.mockResolvedValue({
      required: ['encoder', 'decoder', 'joiner', 'tokens'],
      optional: [],
    });
    mockValidate.mockResolvedValue({ ok: true });
  });

  it('resolves and validates paths for a category', async () => {
    const paths = await resolveCustomModelConfigPaths({
      category: ModelCategory.Stt,
      modelType: 'transducer',
      customConfig: {
        encoder: fsPath('/enc.onnx'),
        decoder: fsPath('/dec.onnx'),
        joiner: fsPath('/join.onnx'),
        tokens: fsPath('/tokens.txt'),
      },
      errorCode: 'TEST_INVALID',
    });
    expect(paths).toEqual({
      encoder: '/enc.onnx',
      decoder: '/dec.onnx',
      joiner: '/join.onnx',
      tokens: '/tokens.txt',
    });
    expect(mockValidate).toHaveBeenCalledWith(
      ModelCategory.Stt,
      'transducer',
      paths
    );
  });

  it('rejects unknown keys using native schema', async () => {
    await expect(
      resolveCustomModelConfigPaths({
        category: 'stt_streaming',
        modelType: 'transducer',
        customConfig: {
          encoder: fsPath('/enc.onnx'),
          unknownKey: fsPath('/x.onnx'),
        },
        errorCode: 'TEST_INVALID',
      })
    ).rejects.toThrow('TEST_INVALID');
  });

  it('throws when native validation fails', async () => {
    mockValidate.mockResolvedValueOnce({
      ok: false,
      error: 'missing files',
      missingRequired: ['tokens'],
    });

    await expect(
      resolveCustomModelConfigPaths({
        category: ModelCategory.Tts,
        modelType: 'vits',
        customConfig: {
          ttsModel: fsPath('/model.onnx'),
        },
        errorCode: 'TEST_INVALID',
      })
    ).rejects.toThrow('TEST_INVALID');
  });
});
