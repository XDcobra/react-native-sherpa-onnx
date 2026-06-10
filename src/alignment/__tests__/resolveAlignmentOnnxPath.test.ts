jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(),
}));

jest.mock('../customConfig', () => ({
  resolveAlignmentCustomConfigPaths: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { resolveFileSourceForModelInit } from '../../detect/resolveModelInput';
import { resolveAlignmentCustomConfigPaths } from '../customConfig';
import {
  accurateOptionsToModelConfig,
  resolveAlignmentOnnxPath,
} from '../resolveAlignmentOnnxPath';

const mockDetect = SherpaOnnx.detectAlignmentModel as jest.Mock;
const mockResolveInit = resolveFileSourceForModelInit as jest.Mock;
const mockResolveCustom = resolveAlignmentCustomConfigPaths as jest.Mock;

describe('resolveAlignmentOnnxPath', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveInit.mockResolvedValue('/models/alignment');
    mockDetect.mockResolvedValue({
      success: true,
      paths: { model: '/models/alignment/model.onnx' },
    });
    mockResolveCustom.mockResolvedValue({ model: '/custom/wav2vec2.onnx' });
  });

  it('auto mode resolves modelSource via detectAlignmentModel', async () => {
    const path = await resolveAlignmentOnnxPath({
      modelSource: fsPath('/models/alignment'),
    });
    expect(path).toBe('/models/alignment/model.onnx');
    expect(mockResolveInit).toHaveBeenCalledWith(fsPath('/models/alignment'));
    expect(mockDetect).toHaveBeenCalledWith('/models/alignment', 'auto');
    expect(mockResolveCustom).not.toHaveBeenCalled();
  });

  it('custom mode resolves customConfig without detectAlignmentModel', async () => {
    const customConfig = { model: fsPath('/custom/wav2vec2.onnx') };
    const path = await resolveAlignmentOnnxPath({
      initMode: 'custom',
      modelType: 'wav2vec2',
      customConfig,
    });
    expect(path).toBe('/custom/wav2vec2.onnx');
    expect(mockResolveCustom).toHaveBeenCalledWith('wav2vec2', customConfig);
    expect(mockDetect).not.toHaveBeenCalled();
    expect(mockResolveInit).not.toHaveBeenCalled();
  });

  it('throws ALIGNMENT_MODEL_MISSING when auto modelSource resolves empty', async () => {
    mockResolveInit.mockResolvedValue('');
    await expect(
      resolveAlignmentOnnxPath({ modelSource: fsPath('/empty') })
    ).rejects.toThrow('ALIGNMENT_MODEL_MISSING');
  });

  it('throws ALIGNMENT_MODEL_LOAD_FAILED when detect fails', async () => {
    mockDetect.mockResolvedValue({ success: false, error: 'no model' });
    await expect(
      resolveAlignmentOnnxPath({ modelSource: fsPath('/bad') })
    ).rejects.toThrow('ALIGNMENT_MODEL_LOAD_FAILED');
  });
});

describe('accurateOptionsToModelConfig', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  it('maps auto accurate options', () => {
    expect(
      accurateOptionsToModelConfig({
        mode: 'accurate',
        modelSource: fsPath('/m'),
        segmentation: { mode: 'off' },
      })
    ).toEqual({
      initMode: 'auto',
      modelSource: fsPath('/m'),
    });
  });

  it('maps custom accurate options', () => {
    const customConfig = { model: fsPath('/custom.onnx') };
    expect(
      accurateOptionsToModelConfig({
        mode: 'accurate',
        initMode: 'custom',
        modelType: 'wav2vec2',
        customConfig,
        segmentation: { mode: 'off' },
      })
    ).toEqual({
      initMode: 'custom',
      modelType: 'wav2vec2',
      customConfig,
    });
  });
});
