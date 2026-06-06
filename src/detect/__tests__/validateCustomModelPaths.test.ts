jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    getCustomModelPathRequirements: jest.fn(),
    validateCustomModelPaths: jest.fn(),
  },
}));

import NativeSherpaOnnx from '../../NativeSherpaOnnx';
import {
  customModelPathFieldKeys,
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  validateCustomModelPaths,
} from '../validateCustomModelPaths';

const mockGetRequirements =
  NativeSherpaOnnx.getCustomModelPathRequirements as jest.Mock;
const mockValidate = NativeSherpaOnnx.validateCustomModelPaths as jest.Mock;

describe('getCustomModelPathRequirements', () => {
  beforeEach(() => {
    mockGetRequirements.mockReset();
  });

  it('returns native fields with file/dir kinds', async () => {
    mockGetRequirements.mockResolvedValue({
      fields: [
        { key: 'ttsModel', required: true, kind: 'file' },
        { key: 'tokens', required: true, kind: 'file' },
        { key: 'dataDir', required: false, kind: 'dir' },
      ],
    });

    const schema = await getCustomModelPathRequirements('tts', 'vits');

    expect(schema.fields).toEqual([
      { key: 'ttsModel', required: true, kind: 'file' },
      { key: 'tokens', required: true, kind: 'file' },
      { key: 'dataDir', required: false, kind: 'dir' },
    ]);
    expect(requiredCustomModelPathFieldKeys(schema)).toEqual([
      'ttsModel',
      'tokens',
    ]);
    expect(customModelPathFieldKeys(schema)).toEqual([
      'ttsModel',
      'tokens',
      'dataDir',
    ]);
  });

  it('returns an empty fields array when native sends none', async () => {
    mockGetRequirements.mockResolvedValue({ fields: [] });

    const schema = await getCustomModelPathRequirements('stt', 'unknown');

    expect(schema).toEqual({ fields: [] });
  });
});

describe('validateCustomModelPaths', () => {
  beforeEach(() => {
    mockValidate.mockReset();
  });

  it('passes through native validation results', async () => {
    mockValidate.mockResolvedValue({
      ok: false,
      error: 'missing files',
      missingRequired: ['tokens'],
    });

    const result = await validateCustomModelPaths('tts', 'vits', {
      ttsModel: '/tmp/model.onnx',
    });

    expect(result).toEqual({
      ok: false,
      error: 'missing files',
      missingRequired: ['tokens'],
    });
    expect(mockValidate).toHaveBeenCalledWith('tts', 'vits', {
      ttsModel: '/tmp/model.onnx',
    });
  });
});
