jest.mock('../../diarization', () => ({
  detectDiarizationModel: jest.fn(),
}));

import { detectDiarizationModel } from '../../diarization';
import { resolveSpeechPyannoteModelForPolicy } from '../resolveSpeechPyannoteModelForPolicy';

const mockDetect = detectDiarizationModel as jest.Mock;

describe('resolveSpeechPyannoteModelForPolicy', () => {
  const fsPath = (path: string) => ({ kind: 'fs' as const, path });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDetect.mockResolvedValue({
      success: true,
      modelType: 'pyannote',
      paths: { model: '/models/pyannote/model.onnx' },
    });
  });

  it('resolves modelPath via detectDiarizationModel', async () => {
    const result = await resolveSpeechPyannoteModelForPolicy(
      fsPath('/models/pyannote')
    );
    expect(result).toEqual({
      modelPath: '/models/pyannote/model.onnx',
      modelType: 'pyannote',
    });
    expect(mockDetect).toHaveBeenCalledWith(fsPath('/models/pyannote'), {
      modelType: 'auto',
    });
  });

  it('throws POLICY_MODEL_UNAVAILABLE when detect fails', async () => {
    mockDetect.mockResolvedValue({ success: false, error: 'missing onnx' });
    await expect(
      resolveSpeechPyannoteModelForPolicy(fsPath('/bad'))
    ).rejects.toMatchObject({
      code: 'POLICY_MODEL_UNAVAILABLE',
      message: expect.stringContaining('missing onnx'),
    });
  });
});
