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

jest.mock('@dr.pogodin/react-native-fs', () => ({
  readFile: jest.fn(),
}));

import fs from 'node:fs';
import path from 'node:path';
import { readFile } from '@dr.pogodin/react-native-fs';
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
const mockReadFile = readFile as jest.Mock;

const FIXTURES = path.join(__dirname, '../../../test/fixtures/alignment');

describe('resolveAlignmentOnnxPath', () => {
  const fsPath = (p: string) => ({ kind: 'fs' as const, path: p });

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveInit.mockResolvedValue('/models/alignment');
    mockDetect.mockResolvedValue({
      success: true,
      paths: {
        model: '/models/alignment/model.onnx',
        vocab: '/models/alignment/vocab.json',
      },
    });
    mockResolveCustom.mockResolvedValue({ model: '/custom/wav2vec2.onnx' });
    mockReadFile.mockRejectedValue(new Error('no vocab mock'));
  });

  it('auto mode resolves modelSource via detectAlignmentModel', async () => {
    const resolved = await resolveAlignmentOnnxPath({
      modelSource: fsPath('/models/alignment'),
    });
    expect(resolved.modelPath).toBe('/models/alignment/model.onnx');
    expect(resolved.vocabPath).toBe('/models/alignment/vocab.json');
    expect(resolved.family).toBe('wav2vec2');
    expect(mockResolveInit).toHaveBeenCalledWith(fsPath('/models/alignment'));
    expect(mockDetect).toHaveBeenCalledWith('/models/alignment', 'auto', null);
    expect(mockResolveCustom).not.toHaveBeenCalled();
  });

  it('custom mode resolves customConfig without detectAlignmentModel', async () => {
    const customConfig = { model: fsPath('/custom/wav2vec2.onnx') };
    const resolved = await resolveAlignmentOnnxPath({
      initMode: 'custom',
      modelType: 'wav2vec2',
      customConfig,
    });
    expect(resolved.modelPath).toBe('/custom/wav2vec2.onnx');
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

  it('overrides romanizer from vocab charset even when folder is renamed', async () => {
    mockResolveInit.mockResolvedValue('/models/my-aligner');
    mockDetect.mockResolvedValue({
      success: true,
      paths: {
        model: '/models/my-aligner/model.onnx',
        vocab: '/models/my-aligner/vocab.json',
      },
    });
    mockReadFile.mockResolvedValue(
      fs.readFileSync(path.join(FIXTURES, 'vocab_mms_fa.json'), 'utf8')
    );

    const resolved = await resolveAlignmentOnnxPath({
      modelSource: fsPath('/models/my-aligner'),
    });
    expect(resolved.profile.id).toBe('char_ctc_generic');
    expect(resolved.profile.needsRomanization).toBe(true);
    expect(resolved.profile.romanizerId).toBe('uroman');
    expect(mockReadFile).toHaveBeenCalledWith(
      '/models/my-aligner/vocab.json',
      'utf8'
    );
  });

  it('keeps identity when vocab has non-Latin letters despite xlsr-like name', async () => {
    mockResolveInit.mockResolvedValue(
      '/models/wav2vec2-xlsr-multilingual-56-q4f16'
    );
    mockDetect.mockResolvedValue({
      success: true,
      paths: {
        model: '/models/wav2vec2-xlsr-multilingual-56-q4f16/model.onnx',
        vocab: '/models/wav2vec2-xlsr-multilingual-56-q4f16/vocab.json',
      },
    });
    mockReadFile.mockResolvedValue(
      fs.readFileSync(
        path.join(FIXTURES, 'vocab_xlsr_nonlatin_sample.json'),
        'utf8'
      )
    );

    const resolved = await resolveAlignmentOnnxPath({
      modelSource: fsPath('/models/wav2vec2-xlsr-multilingual-56-q4f16'),
    });
    expect(resolved.profile.id).toBe('xlsr_56');
    expect(resolved.profile.needsRomanization).toBe(false);
    expect(resolved.profile.romanizerId).toBe('identity');
  });
});

describe('accurateOptionsToModelConfig', () => {
  const fsPath = (p: string) => ({ kind: 'fs' as const, path: p });

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
