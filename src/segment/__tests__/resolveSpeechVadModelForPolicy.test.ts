jest.mock('../../vad/engine', () => ({
  detectVadModel: jest.fn(),
}));

jest.mock('../../vad/customConfig', () => ({
  resolveVadCustomConfigPaths: jest.fn(),
}));

import { detectVadModel } from '../../vad/engine';
import { resolveVadCustomConfigPaths } from '../../vad/customConfig';
import {
  resolveSpeechVadModelForPolicy,
  speechVadPolicyToModelConfig,
} from '../resolveSpeechVadModelForPolicy';
import type { SpeechVadSegmentationPolicy } from '../engine-types';

const mockDetect = detectVadModel as jest.Mock;
const mockResolveCustom = resolveVadCustomConfigPaths as jest.Mock;

describe('resolveSpeechVadModelForPolicy', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDetect.mockResolvedValue({
      success: true,
      modelType: 'silero_vad',
      paths: { model: '/models/vad/silero_vad.onnx' },
    });
    mockResolveCustom.mockResolvedValue({ model: '/custom/silero.onnx' });
  });

  it('auto mode resolves modelPath via detectVadModel', async () => {
    const result = await resolveSpeechVadModelForPolicy({
      modelPath: fsPath('/models/vad'),
    });
    expect(result).toEqual({
      modelPath: '/models/vad/silero_vad.onnx',
      modelType: 'silero_vad',
    });
    expect(mockDetect).toHaveBeenCalledWith(fsPath('/models/vad'), {
      modelType: 'auto',
    });
    expect(mockResolveCustom).not.toHaveBeenCalled();
  });

  it('custom mode resolves customConfig without detectVadModel', async () => {
    const customConfig = { model: fsPath('/custom/silero.onnx') };
    const result = await resolveSpeechVadModelForPolicy({
      initMode: 'custom',
      modelType: 'silero_vad',
      customConfig,
    });
    expect(result).toEqual({
      modelPath: '/custom/silero.onnx',
      modelType: 'silero_vad',
    });
    expect(mockResolveCustom).toHaveBeenCalledWith('silero_vad', customConfig);
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('throws POLICY_MODEL_UNAVAILABLE when auto detect fails', async () => {
    mockDetect.mockResolvedValue({ success: false, error: 'missing onnx' });
    await expect(
      resolveSpeechVadModelForPolicy({ modelPath: fsPath('/bad') })
    ).rejects.toMatchObject({
      code: 'POLICY_MODEL_UNAVAILABLE',
      message: expect.stringContaining('missing onnx'),
    });
  });

  it('throws POLICY_MODEL_UNAVAILABLE when custom path is empty', async () => {
    mockResolveCustom.mockResolvedValue({ model: '' });
    await expect(
      resolveSpeechVadModelForPolicy({
        initMode: 'custom',
        modelType: 'ten_vad',
        customConfig: { model: fsPath('/empty.onnx') },
      })
    ).rejects.toMatchObject({ code: 'POLICY_MODEL_UNAVAILABLE' });
  });
});

describe('speechVadPolicyToModelConfig', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  it('maps auto speech_vad policy', () => {
    const policy: SpeechVadSegmentationPolicy = {
      evaluator: 'speech_vad_model',
      modelPath: fsPath('/models/vad'),
    };
    expect(speechVadPolicyToModelConfig(policy)).toEqual({
      initMode: 'auto',
      modelPath: fsPath('/models/vad'),
    });
  });

  it('maps custom speech_vad policy', () => {
    const customConfig = { model: fsPath('/custom.onnx') };
    const policy: SpeechVadSegmentationPolicy = {
      evaluator: 'speech_vad_model',
      initMode: 'custom',
      modelType: 'silero_vad',
      customConfig,
    };
    expect(speechVadPolicyToModelConfig(policy)).toEqual({
      initMode: 'custom',
      modelType: 'silero_vad',
      customConfig,
    });
  });
});
