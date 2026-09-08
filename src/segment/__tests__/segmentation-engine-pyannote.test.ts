/**
 * Offline-only speech_pyannote_segmentation evaluator wiring.
 */
jest.mock('react-native', () => {
  const mockNative = {
    setLiveTextBufferPartial: jest.fn(),
    appendLiveTextBufferPartial: jest.fn(),
    segmentOfflineBuffer: jest.fn(),
    attachSegmentationEngine: jest.fn(),
    detachSegmentationEngine: jest.fn(),
    getSegmentationEngineInfo: jest.fn(),
    createSegmentLinkMap: jest.fn(),
    addSegmentLink: jest.fn(),
    addSegmentLinks: jest.fn(),
    removeSegmentLink: jest.fn(),
    getSpeechSegmentsForText: jest.fn(),
    getTextSegmentsForSpeech: jest.fn(),
    getAllSegmentLinks: jest.fn(),
    getSegmentLinkCount: jest.fn(),
    getSegmentLinkMapInfo: jest.fn(),
    releaseSegmentLinkMap: jest.fn(),
  };
  return {
    TurboModuleRegistry: {
      getEnforcing: () => mockNative,
    },
    __mockNative: mockNative,
  };
});

jest.mock('../../textbuffer', () => ({
  appendLiveTextSegment: jest.fn(),
  getOfflineTextBufferTextSlice: jest.fn(),
  getLiveTextBufferPartialSlice: jest.fn(),
  getLiveTextBufferSegmentCount: jest.fn(),
  getLiveTextBufferSegments: jest.fn(),
  getPipelineTextBufferInfo: jest.fn(),
  resolvePipelineTextBufferId: jest.fn((value: unknown) => String(value)),
}));

jest.mock('../../audiobuffer', () => ({
  getPipelineAudioBufferInfo: jest.fn(),
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

const mockDetectDiarizationModel = jest.fn();

jest.mock('../../diarization', () => ({
  detectDiarizationModel: (...args: unknown[]) =>
    mockDetectDiarizationModel(...args),
}));

jest.mock('../../segmentbuffer', () => ({
  appendLiveSegment: jest.fn(),
  createEmptyOfflineSegmentBuffer: jest.fn(),
  createLiveSegmentBuffer: jest.fn(),
  createOfflineSegmentBufferFromLive: jest.fn(),
  finalizeLiveSegmentBuffer: jest.fn(),
  getLiveSegmentBufferSegmentCount: jest.fn(),
  getLiveSegmentBufferSegments: jest.fn(),
  getOfflineSegmentBufferSegments: jest.fn(),
  getPipelineSegmentBufferInfo: jest.fn(),
  releasePipelineSegmentBuffer: jest.fn(),
}));

import { attachSegmentationEngine, segmentOfflineBuffer } from '../index';
import { releaseSegmentationStateForBuffer } from '../runtime-state';

describe('segmentation engine pyannote (speech_pyannote_segmentation)', () => {
  const LIVE_AUDIO_ID = 'live_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const OFF_AUDIO_ID = 'off_cccccccc-cccc-cccc-cccc-cccccccccccc';
  const SEG_OFF_ID = 'seg_off_dddddddd-dddd-dddd-dddd-dddddddddddd';

  const native = (jest.requireMock('react-native') as any).__mockNative;

  const pyannotePolicy = {
    evaluator: 'speech_pyannote_segmentation' as const,
    modelPath: {
      kind: 'fs' as const,
      path: '/models/sherpa-onnx-pyannote-segmentation-3-0',
    },
    windowShiftRatio: 0.1,
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    releaseSegmentationStateForBuffer(LIVE_AUDIO_ID);
    releaseSegmentationStateForBuffer(OFF_AUDIO_ID);

    mockDetectDiarizationModel.mockResolvedValue({
      success: true,
      modelType: 'pyannote',
      paths: {
        model: '/models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
      },
      isStreaming: false,
    });

    native.segmentOfflineBuffer.mockResolvedValue({
      bufferId: SEG_OFF_ID,
      kind: 'offlineSegmentBuffer',
      state: 'immutable',
      segmentCount: 2,
      sourceAudioBufferId: OFF_AUDIO_ID,
    });
  });

  it('forwards resolved pyannote policy to native segmentOfflineBuffer', async () => {
    const result = await segmentOfflineBuffer(OFF_AUDIO_ID, pyannotePolicy);

    expect(result.segmentBufferId).toBe(SEG_OFF_ID);
    expect(mockDetectDiarizationModel).toHaveBeenCalledWith(
      pyannotePolicy.modelPath,
      expect.objectContaining({ modelType: 'auto' })
    );
    expect(native.segmentOfflineBuffer).toHaveBeenCalledWith(
      OFF_AUDIO_ID,
      'speech',
      expect.objectContaining({
        evaluator: 'speech_pyannote_segmentation',
        modelPath: '/models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
        modelType: 'pyannote',
        windowShiftRatio: 0.1,
        minDurationOn: 0.3,
        minDurationOff: 0.5,
      })
    );
  });

  it('rejects live attach for offline-only pyannote evaluator', async () => {
    await expect(
      attachSegmentationEngine(LIVE_AUDIO_ID, { policy: pyannotePolicy })
    ).rejects.toThrow(/offline-only/);
    expect(native.attachSegmentationEngine).not.toHaveBeenCalled();
  });

  it('throws POLICY_MODEL_UNAVAILABLE when detectDiarizationModel fails', async () => {
    mockDetectDiarizationModel.mockResolvedValueOnce({
      success: false,
      error: 'missing pyannote onnx',
    });

    await expect(
      segmentOfflineBuffer(OFF_AUDIO_ID, pyannotePolicy)
    ).rejects.toMatchObject({
      code: 'POLICY_MODEL_UNAVAILABLE',
      message: expect.stringContaining('missing pyannote onnx'),
    });
    expect(native.segmentOfflineBuffer).not.toHaveBeenCalled();
  });
});
