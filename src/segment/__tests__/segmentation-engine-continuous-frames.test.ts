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

jest.mock('../../utils', () => ({
  resolveModelPath: jest.fn(async (c: { path: string }) => c.path),
}));

jest.mock('../../audiobuffer', () => ({
  getPipelineAudioBufferInfo: jest.fn(),
  resolvePipelineAudioBufferId: jest.fn((value: any) =>
    typeof value === 'string' ? value : value?.bufferId ?? String(value)
  ),
}));

jest.mock('../../textbuffer', () => ({
  appendLiveTextSegment: jest.fn(),
  getOfflineTextBufferTextSlice: jest.fn(),
  getLiveTextBufferPartialSlice: jest.fn(),
  getLiveTextBufferSegmentCount: jest.fn(),
  getLiveTextBufferSegments: jest.fn(),
  getPipelineTextBufferInfo: jest.fn(),
  resolvePipelineTextBufferId: jest.fn((value: any) =>
    typeof value === 'string' ? value : value?.bufferId ?? String(value)
  ),
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
  getSegments,
  segmentOfflineBuffer,
} from '../index';
import { releaseSegmentationStateForBuffer } from '../runtime-state';

describe('segmentation engine continuous_frames', () => {
  const LIVE_AUDIO_ID = 'live_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const OFFLINE_AUDIO_ID = 'off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const SEG_LIVE_ID = 'seg_live_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const ENGINE_ID = 'eng_continuous_mock_01';

  const segmentbuffer = jest.requireMock('../../segmentbuffer') as any;
  const native = (jest.requireMock('react-native') as any).__mockNative;

  beforeEach(() => {
    jest.clearAllMocks();
    releaseSegmentationStateForBuffer(LIVE_AUDIO_ID);

    native.attachSegmentationEngine.mockResolvedValue({
      engineId: ENGINE_ID,
      segmentBufferId: SEG_LIVE_ID,
    });
    segmentbuffer.getLiveSegmentBufferSegmentCount.mockResolvedValue(2);
    segmentbuffer.getLiveSegmentBufferSegments.mockResolvedValue([
      {
        kind: 'speech',
        id: 'speech_checkpoint_0',
        sourceAudioBufferId: LIVE_AUDIO_ID,
        startSample: 0,
        endSample: 4000,
        sampleRate: 16000,
        durationMs: 250,
        reason: 'policy_checkpoint',
        source: 'segmentation_engine',
        createdAtMs: 10_000,
      },
      {
        kind: 'speech',
        id: 'speech_checkpoint_1',
        sourceAudioBufferId: LIVE_AUDIO_ID,
        startSample: 4000,
        endSample: 8000,
        sampleRate: 16000,
        durationMs: 250,
        reason: 'policy_checkpoint',
        source: 'segmentation_engine',
        createdAtMs: 10_250,
      },
    ]);
  });

  it('attaches continuous_frames and exposes only policy_checkpoint live segments', async () => {
    await attachSegmentationEngine(LIVE_AUDIO_ID, {
      policy: {
        evaluator: 'continuous_frames',
        checkpointIntervalMs: 250,
      },
    });

    expect(native.attachSegmentationEngine).toHaveBeenCalledWith(
      LIVE_AUDIO_ID,
      'speech',
      {
        evaluator: 'continuous_frames',
        checkpointIntervalMs: 250,
      }
    );

    const segments = await getSegments(LIVE_AUDIO_ID, 0, 10);

    expect(segments).toHaveLength(2);
    expect(
      segments.every((segment) => segment.reason === 'policy_checkpoint')
    ).toBe(true);
    expect(
      segments.some(
        (segment) =>
          segment.reason === 'energy_silence' ||
          segment.reason === 'length_limit' ||
          segment.reason === 'vad_boundary'
      )
    ).toBe(false);
  });

  it('rejects continuous_frames for offline segmentation', async () => {
    native.segmentOfflineBuffer.mockRejectedValue(
      new Error(
        "POLICY_INVALID_FOR_OFFLINE: Policy evaluator 'continuous_frames' is streaming-only"
      )
    );

    await expect(
      segmentOfflineBuffer(OFFLINE_AUDIO_ID, {
        evaluator: 'continuous_frames',
        checkpointIntervalMs: 250,
      })
    ).rejects.toThrow('POLICY_INVALID_FOR_OFFLINE');

    expect(native.segmentOfflineBuffer).toHaveBeenCalledWith(
      OFFLINE_AUDIO_ID,
      'speech',
      {
        evaluator: 'continuous_frames',
        checkpointIntervalMs: 250,
      }
    );
  });
});
