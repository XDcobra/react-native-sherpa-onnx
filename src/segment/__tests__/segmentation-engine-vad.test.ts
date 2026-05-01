/**
 * Phase 2 plan A6: mock native `attachSegmentationEngine` with `speech_vad_model`,
 * assert engine info shape and live speech segments expose `reason: 'vad_boundary'`.
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

const mockDetectVadModel = jest.fn();

jest.mock('../../vad/engine', () => ({
  detectVadModel: (...args: unknown[]) => mockDetectVadModel(...args),
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

import {
  attachSegmentationEngine,
  getSegmentationEngineInfo,
  getSegments,
} from '../index';
import { releaseSegmentationStateForBuffer } from '../runtime-state';

describe('segmentation engine VAD (speech_vad_model)', () => {
  const LIVE_AUDIO_ID = 'live_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const SEG_LIVE_ID = 'seg_live_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const ENGINE_ID = 'eng_vad_mock_01';

  const mockSegmentbuffer = jest.requireMock('../../segmentbuffer') as any;
  const native = (jest.requireMock('react-native') as any).__mockNative;

  const vadPolicy = {
    evaluator: 'speech_vad_model' as const,
    modelPath: { kind: 'fs' as const, path: '/models/vad/silero_vad.onnx' },
    vadThreshold: 0.48,
    vadMinSpeechMs: 120,
    vadMinSilenceMs: 300,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    releaseSegmentationStateForBuffer(LIVE_AUDIO_ID);

    mockDetectVadModel.mockResolvedValue({
      success: true,
      modelType: 'silero_vad',
      paths: { model: '/models/vad/silero_vad.onnx' },
      isStreaming: false,
    });

    native.attachSegmentationEngine.mockResolvedValue({
      engineId: ENGINE_ID,
      segmentBufferId: SEG_LIVE_ID,
    });

    native.getSegmentationEngineInfo.mockResolvedValue({
      engineId: ENGINE_ID,
      attachedBufferId: LIVE_AUDIO_ID,
      domain: 'speech',
      policy: vadPolicy,
      state: 'active',
      totalSegmentsCommitted: 2,
      lastSegmentId: 'speech_seg_vad_2',
      segmentBufferId: SEG_LIVE_ID,
    });

    mockSegmentbuffer.getLiveSegmentBufferSegmentCount.mockResolvedValue(1);
    mockSegmentbuffer.getLiveSegmentBufferSegments.mockResolvedValue([
      {
        kind: 'speech',
        id: 'speech_seg_vad_boundary_0',
        sourceAudioBufferId: LIVE_AUDIO_ID,
        startSample: 0,
        endSample: 8000,
        sampleRate: 16000,
        durationMs: 500,
        reason: 'vad_boundary',
        source: 'segmentation_engine',
        createdAtMs: 42_000,
      },
    ]);
  });

  it('forwards speech_vad_model policy to native attachSegmentationEngine', async () => {
    await attachSegmentationEngine(LIVE_AUDIO_ID, { policy: vadPolicy });

    expect(native.attachSegmentationEngine).toHaveBeenCalledTimes(1);
    expect(native.attachSegmentationEngine).toHaveBeenCalledWith(
      LIVE_AUDIO_ID,
      'speech',
      expect.objectContaining({
        evaluator: 'speech_vad_model',
        modelPath: '/models/vad/silero_vad.onnx',
        modelType: 'silero_vad',
        vadThreshold: 0.48,
      })
    );
    expect(mockDetectVadModel).toHaveBeenCalledWith(
      vadPolicy.modelPath,
      expect.objectContaining({ modelType: 'auto' })
    );
  });

  it('throws POLICY_MODEL_UNAVAILABLE when detectVadModel fails', async () => {
    mockDetectVadModel.mockResolvedValueOnce({
      success: false,
      error: 'missing onnx',
    });

    await expect(
      attachSegmentationEngine(LIVE_AUDIO_ID, { policy: vadPolicy })
    ).rejects.toMatchObject({
      code: 'POLICY_MODEL_UNAVAILABLE',
      message: expect.stringContaining('missing onnx'),
    });
    expect(native.attachSegmentationEngine).not.toHaveBeenCalled();
  });

  it('exposes SegmentationEngineInfo snapshot for VAD-attached engine', async () => {
    await attachSegmentationEngine(LIVE_AUDIO_ID, { policy: vadPolicy });

    const info = await getSegmentationEngineInfo({ engineId: ENGINE_ID });

    expect(info).toMatchSnapshot();
  });

  it('maps live speech segments with reason vad_boundary from native buffer', async () => {
    await attachSegmentationEngine(LIVE_AUDIO_ID, { policy: vadPolicy });

    const segments = await getSegments(LIVE_AUDIO_ID, 0, 10);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      domain: 'speech',
      reason: 'vad_boundary',
      source: 'segmentation_engine',
      segmentId: 'speech_seg_vad_boundary_0',
      sourceAudioBufferId: LIVE_AUDIO_ID,
      startOffset: 0,
      endOffset: 8000,
      sampleRate: 16000,
      durationMs: 500,
      createdAtMs: 42_000,
    });
  });
});
